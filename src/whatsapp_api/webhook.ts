import log from "../lib/logger";
import { Model } from "@sequelize/core";
import {
  WhatsAppChange,
  WhatsAppContact,
  WhatsAppMessage,
  WhatsAppMessageType,
  WhatsAppStatus,
  WhatsAppWebhookPayload,
} from "../types/MetaAPI";
import { downloadMediaMessage, WAMessage } from "baileys";
import logger from "../lib/logger";
import { revWhatsAppId } from "./formatNumbers";
import { WhatsappService } from "../services/WhatsappService";
import {
  ResolvedSender,
  storeLidMapping,
  jidToPhoneDigits,
} from "../services/lidMappingService";

function formatStatus(messageAck: any): WhatsAppStatus {
  const acks: {
    [key: number]: "sent" | "delivered" | "read" | "failed" | "deleted";
  } = {
    [0]: "failed",
    [1]: "sent",
    [2]: "sent",
    [3]: "delivered",
    [4]: "read",
    [5]: "read",
  };
  return {
    id: messageAck.key.id || "",
    status: acks[messageAck.update.status ?? 0],
    timestamp: Math.floor(Date.now()).toString(),
    recipient_id: messageAck.key.remoteJid || "",
  };
}

async function downloadMedia(message: WAMessage) {
  if (!message.message?.audioMessage)
    return {
      data: "",
      mimetype: "",
      filesize: 0,
      filename: "",
    };
  const buffer = await downloadMediaMessage(message, "buffer", {});
  const base64Audio = buffer.toString("base64");
  const mimetype = message.message.audioMessage.mimetype || "audio/ogg";
  var fileSize = message.message.audioMessage.fileLength || buffer.length;
  if (typeof fileSize == "object") {
    try {
      fileSize = Number(fileSize);
    } catch (e) {
      fileSize = 0;
    }
  }
  return {
    data: base64Audio,
    mimetype,
    filesize: fileSize,
    filename: message.message.audioMessage.url ?? "",
  };
}

/**
 * Jid "cru" (com domínio) usado para identificar o remetente de uma mensagem,
 * antes de qualquer resolução de lid -> telefone. Pode vir como número real
 * (`@s.whatsapp.net`) ou como lid (`@lid`), dependendo do addressingMode.
 */
function getRawSenderJid(message: WAMessage): string {
  const isGroup = message.key.remoteJid?.includes("@g.us") ?? false;
  return message.key.addressingMode == "pn"
    ? (message.key.remoteJid ?? "")
    : !isGroup
      ? (message.key.remoteJidAlt ?? message.key.remoteJid ?? "")
      : (message.key.participantAlt ?? message.key.participant ?? "");
}

async function formatMessage(
  message: WAMessage,
  sender: ResolvedSender,
): Promise<WhatsAppMessage> {
  const from = revWhatsAppId(
    (
      message.message?.extendedTextMessage?.contextInfo?.participant ?? ""
    ).split("@")[0],
  );
  const quote = !!message.message?.extendedTextMessage?.contextInfo
    ? {
        from: from,
        id: message.message?.extendedTextMessage?.contextInfo?.stanzaId ?? "",
      }
    : undefined;
  const isGroup = message.key.remoteJid?.includes("@g.us") ?? false;
  logger.debug("message", message);
  return {
    from: sender.resolved ? revWhatsAppId(sender.phone) : "",
    lid: sender.resolved ? undefined : jidToPhoneDigits(sender.lid),
    pushName: message.pushName || undefined,
    id: message.key.id ?? "",
    timestamp: Math.floor(Number(message.messageTimestamp)).toString(),
    type: message.message?.audioMessage ? "audio64" : "text",
    text: !!message.message?.audioMessage
      ? {
          audio: await downloadMedia(message),
        }
      : {
          body: message.message?.extendedTextMessage
            ? (message.message.extendedTextMessage.text ?? "")
            : (message.message?.conversation ?? ""),
        },
    context:
      isGroup || quote
        ? {
            ...(quote ?? {}),
            group_id: isGroup ? (message.key.remoteJid ?? "") : undefined,
          }
        : undefined,
    fullBody: JSON.stringify(message),
  };
}

/**
 * Resolve o remetente de cada mensagem (telefone real ou, na falta dele,
 * o lid cru). Nada é segurado: a mensagem sempre vai pro webhook, só que
 * marcada como lid quando o telefone ainda não é conhecido — quem decide o
 * que fazer com isso (ex: não criar lead com "telefone" inválido) é o
 * backend consumidor.
 */
async function resolveMessages(
  waService: WhatsappService,
  messages: WAMessage[],
): Promise<{ message: WAMessage; sender: ResolvedSender }[]> {
  const results: { message: WAMessage; sender: ResolvedSender }[] = [];
  for (const message of messages) {
    const rawJid = getRawSenderJid(message);
    const sender = await waService.resolveSenderJid(rawJid);
    if (!sender.resolved) {
      logger.warn(`Mensagem de lid ainda não resolvido, enviando marcada: ${rawJid}`);
      await waService.requestPhoneNumber(rawJid);
    }
    results.push({ message, sender });
  }
  return results;
}

async function buildMessageChange(
  client: Model<any, any>,
  waService: WhatsappService,
  messages: WAMessage[],
): Promise<WhatsAppChange | null> {
  const resolved = await resolveMessages(waService, messages);
  if (resolved.length === 0) return null;

  const contacts = resolved.map(({ message, sender }) => ({
    profile: {
      name: message.pushName ?? "",
      lid: message.key.participant ?? message.key.remoteJid ?? "",
    },
    wa_id: sender.resolved ? sender.phone : "",
    lid: sender.resolved ? undefined : jidToPhoneDigits(sender.lid),
  }));
  return {
    value: {
      messaging_product: "whatsapp",
      metadata: {
        display_phone_number: client.get("name") as string,
        phone_number_id: client.get("clientId") as string,
      },
      contacts: contacts,
      messages: await Promise.all(
        resolved.map(({ message, sender }) => formatMessage(message, sender)),
      ),
    },
    field: "messages",
  };
}
async function buildStatusChange(
  client: Model<any, any>,
  messageAcks: WAMessage[],
): Promise<WhatsAppChange> {
  return {
    value: {
      messaging_product: "whatsapp",
      metadata: {
        display_phone_number: client.get("name") as string,
        phone_number_id: client.get("clientId") as string,
      },
      statuses: messageAcks?.map(formatStatus),
    },
    field: "message_status",
  };
}

export async function webhookHandler(
  client: Model<any, any>,
  waService: WhatsappService,
  messages: WAMessage[],
  messageAcks: WAMessage[],
) {
  if (messages.length == 0 && messageAcks.length == 0) return true;
  await client.reload();
  const webhookUrl = client.get("webHook") as string | null;
  try {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_web_account",
      entry: [
        {
          id: client.get("clientId") as string,
          changes: [] as any[],
        },
      ],
    };
    if (messages.length > 0) {
      const change = await buildMessageChange(client, waService, messages);
      if (change) payload.entry[0].changes.push(change);
    }
    if (messageAcks.length > 0) {
      payload.entry[0].changes.push(
        await buildStatusChange(client, messageAcks),
      );
    }
    if (payload.entry[0].changes.length === 0) return true;
    log.debug("Payload webhook: ", {
      entry: payload.entry[0].changes,
      url: webhookUrl,
    });
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  } catch (error) {
    log.warn("Failed to notify webhook of message:", error);
    return false;
  }
  return true;
}

/**
 * Chamado quando o Baileys resolve um par lid/telefone (`lid-mapping.update`),
 * por exemplo depois que o contato aceita compartilhar o número após um
 * `requestPhoneNumber`. Grava no mapeamento global e avisa o backend com um
 * evento dedicado (`lid_resolved`) para que ele troque as referências ao lid
 * pelo telefone real e continue o fluxo normalmente.
 */
export async function handleLidMappingUpdate(
  client: Model<any, any>,
  mapping: { lid: string; pn: string },
) {
  const lid = jidToPhoneDigits(mapping.lid);
  const phone = jidToPhoneDigits(mapping.pn);
  await storeLidMapping(mapping.lid, phone);

  const webhookUrl = client.get("webHook") as string | null;
  if (!webhookUrl) return;

  const payload: WhatsAppWebhookPayload = {
    object: "whatsapp_web_account",
    entry: [
      {
        id: client.get("clientId") as string,
        changes: [
          {
            field: "lid_resolved",
            value: {
              phone_number_id: client.get("clientId") as string,
              lid,
              phone,
            },
          },
        ],
      },
    ],
  };
  try {
    log.debug("Payload webhook (lid_resolved): ", { entry: payload.entry[0].changes, url: webhookUrl });
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    log.warn("Failed to notify webhook of lid_resolved:", error);
  }
}
