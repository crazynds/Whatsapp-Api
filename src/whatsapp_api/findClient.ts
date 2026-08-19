import { FindOrCreateOptions } from "@sequelize/core";
import ClientModel from "../models/client";
import { clients, deleteClient } from ".";
import QRCode from "qrcode";
import { webhookHandler, handleLidMappingUpdate } from "./webhook";
import log from "../lib/logger";
import path from "path";
import { WhatsappService } from "../services/WhatsappService";

export async function findClient(clientId: any, can_create: boolean = false) {
  const opts: FindOrCreateOptions = {
    where: { clientId: clientId },
  };

  const [clientModel, created] = await ClientModel.findOrCreate(opts);
  if (!created && clients[clientId]) {
    return clientModel;
  }

  const client = await new Promise<WhatsappService | false>(
    async (resolve, reject) => {
      const sessionDir = path.join(process.cwd(), "data", "sessions");
      const waService = new WhatsappService(clientId.toString());
      const disconectEvent = async () => {
        log.warn("Client disconected: " + clientId);
        const wh = clientModel.get("webHook") as string | null;
        delete clients[clientId];
        clientModel.set({
          ready: false,
        });
        clientModel.save();
        if (wh) {
          try {
            await fetch(wh, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                object: "whatsapp_web_account",
                entry: [
                  {
                    id: clientModel.get("clientId"),
                    changes: [
                      {
                        value: {
                          messaging_product: "whatsapp",
                          metadata: {
                            display_phone_number: clientModel.get("name"),
                            phone_number_id: clientModel.get("clientId"),
                          },
                        },
                        field: "whatsapp_web_disconected",
                      },
                    ],
                  },
                ],
              }),
            });
          } catch (ex) {}
        }
        deleteClient(clientModel.get("clientId")); // Delete model from database
        waService.destroy(); // Clear session dir and close connection
        resolve(false);
      };

      waService.onClose(disconectEvent);
      waService.onQrCode(async (qrCode: string) => {
        clientModel.set({
          qrCode: await QRCode.toDataURL(qrCode),
          ready: false,
        });
        await clientModel.save();
        resolve(waService);
      });
      waService.onOpen(async () => {
        clientModel.set({
          ready: true,
        });
        await clientModel.save();
        log.info("Client initialized: " + clientId.toString());
        resolve(waService);
      });
      waService.onCredentials(async (creds) => {
        clientModel.set({
          name: creds.me?.id,
          phoneId: creds.me?.id,
          ready: true,
        });
        await clientModel.save();
      });
      waService.onUpdate(async (messages) => {
        const a = await webhookHandler(clientModel, waService, [], messages);
        // messages.forEach(async (message) => {
        //   switch (message.update.keepInChat) {
        //   case MessageAck.ACK_ERROR:
        //     log.error("Error on send message: " + message.id);
        //     break;
        //   case MessageAck.ACK_PENDING:
        //     log.debug("Message not sent yet: " + message.id);
        //     break;
        //   case MessageAck.ACK_SERVER:
        //     log.http("Message Sended Sucessfuly: " + message.id);
        //     break;
        //   case MessageAck.ACK_DEVICE:
        //   case MessageAck.ACK_READ:
        //   case MessageAck.ACK_PLAYED:
        //     log.http("Message ack: " + message.id);
        //     const a = await webhookHandler(clientModel, [], [message]);
        //     break;
        // }
        // })
      });
      waService.onLidMapping(async (mapping) => {
        await handleLidMappingUpdate(clientModel, mapping);
      });
      waService.onMessage(async ({ messages }) => {
        const a = await webhookHandler(
          clientModel,
          waService,
          messages
            .filter((message) => {
              return (
                message.status !== 0 &&
                message.key.remoteJid &&
                message.key.id &&
                !message.key.fromMe &&
                message.key.remoteJid != "status@broadcast"
              );
            })
            .filter((message) => {
              return (
                message.message?.audioMessage ||
                (message.message?.extendedTextMessage
                  ? (message.message.extendedTextMessage.text ?? "")
                  : (message.message?.conversation ?? ""))
              );
            }),
          [],
        );
      });
      waService.connect(sessionDir);

      // client.on("message_ack", async (message, ack) => {
      //   switch (ack) {
      //     case MessageAck.ACK_ERROR:
      //       log.error("Error on send message: " + message.id);
      //       break;
      //     case MessageAck.ACK_PENDING:
      //       log.debug("Message not sent yet: " + message.id);
      //       break;
      //     case MessageAck.ACK_SERVER:
      //       log.http("Message Sended Sucessfuly: " + message.id);
      //       break;
      //     case MessageAck.ACK_DEVICE:
      //     case MessageAck.ACK_READ:
      //     case MessageAck.ACK_PLAYED:
      //       log.http("Message ack: " + message.id);
      //       const a = await webhookHandler(clientModel, [], [message]);
      //       break;
      //   }
      // });

      // // TODO: message edit, delete, reaction
      // client.on("message_edit", async () => {});
      // client.on("message_delete", async () => {});
      // client.on("message_reaction", async () => {});

      // client.on("message", async (msg) => {
      //   log.http("Message recived: " + clientModel.get("name"));
      //   const a = await webhookHandler(clientModel, [msg], []);
      //   if (!a) {
      //     log.warn("message_handler failed");
      //   }
      // });

      clients[clientId] = waService;
      return waService;
    },
  ).catch((err) => {
    log.error(err);
  });

  if (!client) {
    await clientModel.destroy();
    delete clients[clientId];
    return null;
  }

  if (!clientModel.get("ready") && !can_create) {
    client.logout();
    client.destroy();
    clientModel.destroy();
    delete clients[clientId];
    return null;
  }
  return clientModel;
}
