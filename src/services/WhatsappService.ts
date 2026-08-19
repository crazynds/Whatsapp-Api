import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
  BaileysEventMap,
  AuthenticationState,
  BufferJSON,
  AnyMessageContent,
} from "baileys";
import { Boom } from "@hapi/boom";
import * as path from "path";
import logger from "../lib/logger";
import { ILogger } from "baileys/lib/Utils/logger";
import fs from "fs";
import { useSQLiteAuthState } from "./sqlite-state";
import {
  resolveSenderJid,
  ResolvedSender,
  shouldRequestPhoneNumber,
} from "./lidMappingService";
import { isLidUser } from "baileys";

interface ChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
}

const fetchLatestWaConnectVersion = async (options = {}) => {
  try {
    const response = await fetch("https://wppconnect.io/whatsapp-versions/", {
      method: "GET",
    });
    if (!response.ok) {
      throw new Boom(`Failed to fetch sw.js: ${response.statusText}`, {
        statusCode: response.status,
      });
    }
    const data = await response.text();
    const regex = /(\d+)\.(\d+)\.(\d+)-alpha/g;
    const match = regex.exec(data);
    if (!match) {
      return false;
    }
    const [full, major, minor, patch] = match;
    return {
      version: [Number(major), Number(minor), Number(patch)],
      isLatest: true,
    };
  } catch (error) {
    return false;
  }
};

export class WhatsappService {
  private sock: WASocket | null = null;
  private sessionId: string;
  private callbacks: { [key: string]: CallableFunction } = {};
  private status = "off";
  private removeCreds: (() => Promise<void>) | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Inicializa a sessão do WhatsApp
   */
  public async connect(sessionDir: string): Promise<void> {
    const oldSessionDir = path.join(sessionDir, `${this.sessionId}`);
    const oldState = await useMultiFileAuthState(oldSessionDir);
    const old = false;
    var state: AuthenticationState,
      saveCreds: (newCreds: any) => Promise<void>,
      removeCreds: (() => Promise<void>) | undefined;
    if (old) {
      state = oldState.state;
      saveCreds = oldState.saveCreds;
    } else {
      var dbState = await await useSQLiteAuthState({
        filename: "data/session.db",
        sessionId: this.sessionId,
      });
      state = dbState.state;
      saveCreds = dbState.saveCreds;
      removeCreds = dbState.removeCreds;
      if (oldState.state.creds.me?.id) {
        await dbState.setCreds(oldState.state.creds);
        dbState = await await useSQLiteAuthState({
          filename: "data/session.db",
          sessionId: this.sessionId,
        });
        state = dbState.state;
        saveCreds = dbState.saveCreds;
        removeCreds = dbState.removeCreds;

        if (fs.existsSync(oldSessionDir)) {
          fs.rmSync(oldSessionDir, { recursive: true });
        }
      }
    }
    this.removeCreds = removeCreds ?? null;

    const waVersion = await fetchLatestWaConnectVersion();
    const { version: baileysVersion } = await fetchLatestBaileysVersion();

    var version: any;
    if (!waVersion) {
      version = baileysVersion;
    } else {
      version = waVersion.version;
    }
    const sessionId = this.sessionId;
    const customLogger = {
      level: logger.level,
      child(obj: Record<string, any>) {
        return customLogger;
      },
      trace(obj: any, msg?: string) {
        return null;
      },
      debug(obj: any, msg?: string) {
        if (!msg) return;
        //logger.debug(msg, obj);
      },
      info(obj: any, msg?: string) {
        if (!msg) return;
        switch (msg) {
          case "connected to WA":
          case "not logged in, attempting registration...":
            logger.debug(sessionId + " - " + msg, obj);
            break;
          case "logging in...":
            logger.info(sessionId + " - " + msg);
            break;
          default:
            logger.info(sessionId + " - " + msg);
        }
      },
      warn(obj: any, msg?: string) {
        if (!msg) return;
        logger.warn(sessionId + " - " + msg, obj);
      },
      error(obj: any, msg?: string) {
        if (!msg) return;
        logger.error(sessionId + " - " + msg, obj);
      },
    } as ILogger;
    this.sock = makeWASocket({
      version,
      auth: state,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: customLogger,
    });

    this.status = "started";

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.status = "qrCode";
        if ("qrCode" in this.callbacks) this.callbacks["qrCode"](qr);
      }
      if (connection === "close") {
        const shouldReconnect =
          [
            DisconnectReason.connectionLost,
            DisconnectReason.connectionReplaced,
            DisconnectReason.connectionClosed,
            DisconnectReason.restartRequired,
            DisconnectReason.timedOut,
            DisconnectReason.unavailableService,
            DisconnectReason.badSession,
          ].includes((lastDisconnect?.error as Boom)?.output?.statusCode) ||
          (lastDisconnect?.error as Boom)?.output.payload.message ==
            "Stream Errored (conflict)";

        if (shouldReconnect) this.connect(sessionDir);
        else if ("close" in this.callbacks) {
          logger.error("Disconected, reason: ", lastDisconnect?.error);
          if (removeCreds) removeCreds().then(() => {});
          this.status = "closed";

          this.callbacks["close"]();
        }
      } else if (connection === "open") {
        this.status = "opened";
        if ("open" in this.callbacks) this.callbacks["open"]();
      }
    });

    this.sock.ev.on("messages.upsert", async (m) => {
      if (m.type == "notify") {
        if ("message" in this.callbacks)
          this.callbacks["message"]({
            ...m,
            messages: m.messages,
            //.filter((m) => !m.key.fromMe),
          });
      } else {
        // old already seen / handled messages
        // handle them however you want to
      }
    });
    this.sock.ev.on(
      "messaging-history.set",
      ({
        chats: newChats,
        contacts: newContacts,
        messages: newMessages,
        syncType,
      }) => {
        //console.log(newChats, newContacts, newMessages, syncType);
      },
    );
    this.sock.ev.on("creds.update", (creds) => {
      if ("credentials" in this.callbacks) this.callbacks["credentials"](creds);
    });
    this.sock.ev.on("messages.update", (m) => {
      if ("update" in this.callbacks) this.callbacks["update"](m);
    });
    this.sock.ev.on("lid-mapping.update", (mapping) => {
      if ("lidMapping" in this.callbacks) this.callbacks["lidMapping"](mapping);
    });
  }

  public on(event: keyof BaileysEventMap, callback: any) {
    if (!this.sock) throw new Error("Socket não inicializado");
    this.sock.ev.on(event, callback);
  }

  public onQrCode(callback: CallableFunction) {
    this.callbacks["qrCode"] = callback;
  }
  public onOpen(callback: CallableFunction) {
    this.callbacks["open"] = callback;
  }
  public onClose(callback: CallableFunction) {
    this.callbacks["close"] = callback;
  }
  public onUpdate(callback: (arg: BaileysEventMap["messages.update"]) => void) {
    this.callbacks["update"] = callback;
  }
  public onCredentials(
    callback: (arg: BaileysEventMap["creds.update"]) => void,
  ) {
    this.callbacks["credentials"] = callback;
  }
  public onMessage(
    callback: (arg: BaileysEventMap["messages.upsert"]) => void,
  ) {
    this.callbacks["message"] = callback;
  }
  public onLidMapping(
    callback: (arg: BaileysEventMap["lid-mapping.update"]) => void,
  ) {
    this.callbacks["lidMapping"] = callback;
  }

  /**
   * Resolve um jid de remetente (telefone ou lid) para o telefone real,
   * usando o mapeamento global e o lidMapping nativo do Baileys.
   */
  public async resolveSenderJid(jid: string): Promise<ResolvedSender> {
    if (!this.sock) throw new Error("Socket não inicializado");
    return resolveSenderJid(this.sock, jid);
  }

  /**
   * Envia uma mensagem para um número (ou lid, quando o telefone real ainda
   * não é conhecido pelo backend).
   */
  public async sendMessage(
    to: string,
    message: string | null = null,
    mediaPath: string | null = null,
    mimetype: string | null = null,
    isVoice: boolean = false,
  ) {
    if (!this.sock) throw new Error("Socket não inicializado");
    if (!message && !mediaPath)
      throw new Error("Nada para enviar: sem texto nem mídia");
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    this.sock.sendPresenceUpdate("available");
    this.sock.sendPresenceUpdate(mediaPath && isVoice ? "recording" : "composing", jid);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.log2((message?.length ?? 0) + 10) * 700),
    );
    this.sock.sendPresenceUpdate("available", jid);

    const content = this.buildMessageContent(message, mediaPath, mimetype, isVoice);
    await this.sock.sendMessage(jid, content);
    this.sock.sendPresenceUpdate("unavailable");
  }

  /**
   * Pede (via prompt nativo do WhatsApp) que o dono do lid compartilhe seu
   * telefone real. Chamado ao receber uma mensagem cujo remetente ainda não
   * foi resolvido — a resposta chega depois pelo evento `lid-mapping.update`.
   * Respeita um cooldown para não repetir o pedido a cada mensagem.
   */
  public async requestPhoneNumber(lid: string): Promise<void> {
    if (!this.sock) throw new Error("Socket não inicializado");
    if (!isLidUser(lid)) return;
    if (!shouldRequestPhoneNumber(lid)) return;
    logger.info(`Solicitando telefone real para lid ${lid}`);
    await this.sock.sendMessage(lid, { requestPhoneNumber: true });
  }

  /**
   * Monta o conteúdo da mensagem do Baileys de acordo com o tipo de mídia.
   */
  private buildMessageContent(
    message: string | null,
    mediaPath: string | null,
    mimetype: string | null,
    isVoice: boolean,
  ): AnyMessageContent {
    if (!mediaPath) {
      return { text: message ?? "" };
    }
    const mime = mimetype ?? "application/octet-stream";
    const caption = message ?? undefined;
    if (mime.startsWith("image/")) {
      return { image: { url: mediaPath }, mimetype: mime, caption };
    }
    if (mime.startsWith("video/")) {
      return { video: { url: mediaPath }, mimetype: mime, caption };
    }
    if (mime.startsWith("audio/")) {
      return { audio: { url: mediaPath }, mimetype: mime, ptt: isVoice };
    }
    return {
      document: { url: mediaPath },
      mimetype: mime,
      fileName: path.basename(mediaPath),
      caption,
    };
  }

  // /**
  //  * Retorna a lista de contatos
  //  */
  // public getContacts() {
  //   if (!this.sock) throw new Error("Socket não inicializado");
  //   return this.sock.store?.contacts || {};
  // }

  // /**
  //  * Retorna os chats
  //  */
  // public async listActiveChats(): Promise<ChatInfo[]> {

  // }

  public async checkNumber(number: string) {
    if (!this.sock) throw new Error("Socket não inicializado");
    const resp = await this.sock.onWhatsApp(number);
    if (!resp || resp?.length <= 0 || !resp[0]) return false;
    return resp[0].exists;
  }

  /**
   * Desloga e encerra a sessão
   */
  public async logout() {
    try {
      if (!this.sock) throw new Error("Socket não inicializado");
      await this.sock.logout();
    } catch (e) {}
  }

  public async destroy() {
    try {
      await this.logout();
    } catch (e) {}
    // Remove session credentials from SQLite
    if (this.removeCreds) await this.removeCreds();
  }

  public getStatus() {
    return this.status;
  }
}
