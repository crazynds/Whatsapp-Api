import express, { Request, Response } from 'express';
import sequelize from './lib/sequelize';
import { createClient, getChatMessages, getChats, sendMessage } from './whatsapp_api';
import Client from './models/client';
import QRCode from 'qrcode';

export const port: number = parseInt(process.env.PORT ?? '3000');
const server = express()

export default server;

export async function createWebServer () {
  server.get('/', (req: Request, res: Response) => {
    res.send('Hello, TypeScript + Node.js + Express! MAS ISSO TA BOM DEMAIS');
  });


  server.get('/client/:clientId/create',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    let client = await Client.findByPk(id);

    // Create a cliente if it doesnt exist
    if(!client){
      client = await createClient(id);
    }
    // Set webhook
    if(req.query.webHook){
      client.set('webHook', req.query.webHook as string);
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      clientId: id
    }));
  });
  
  
  // Create a clientId
  server.get('/client/:clientId',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client)return res.status(404).send('Not found');

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      clientId: client.get('clientId'),
      ready: client.get('ready'),
      qr: client.get('qrCode') ?? null,
      webHook: client.get('webHook') ?? null
    }));
  });
  
  // render the qr code
  server.get('/client/:clientId/qrCode',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client || !client.get('qrCode'))return res.status(404).send('Not found');

    const qrCode = client.get('qrCode') as string;

    const qrCodeImage = await QRCode.toDataURL(qrCode);
    res.send(`<img src="${qrCodeImage}" alt="QR Code"/>`);
  });

  // get chats
  server.get('/client/:clientId/chat',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client || !client.get('ready'))return res.status(404).send('Not found');

    const chats = getChats(client);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(chats));
  })

  // send messages to clients
  server.post('/client/:clientId/chat/:chatId/send',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client || !client.get('ready'))return res.status(404).send('Not found');

    const chatId = req.body.chatId;

    const result = sendMessage(client,chatId,req.body.message);
    
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  })

  // get chat messages
  server.get('/client/:clientId/chat/:chatId/messages',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client || !client.get('ready'))return res.status(404).send('Not found');

    const chatId = req.params.chatId;

    const messages = getChatMessages(client,chatId,200);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(messages));
  })

  
  server.listen(port, () => {
    // Ready
    console.log(`!!WebServer Started!!`);
  });
  return server
}

