import express, { Request, Response } from 'express';
import sequelize from './lib/sequelize';
import { createClient } from './whatsapp_api';
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

    if(!client){
      client = await createClient(id);
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      clientId: id
    }));
  });

  
  server.get('/client/:clientId/ready',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client)return res.status(404).send('Not found');

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      clientId: client.get('clientId'),
      ready: client.get('ready'),
      qr: client.get('qrCode') ?? null
    }));
  });
  
  server.get('/client/:clientId/qrCode',async (req: Request, res: Response) => {
    const id = req.params.clientId;
    const client = await Client.findByPk(id);

    if(!client || !client.get('qrCode'))return res.status(404).send('Not found');

    const qrCode = client.get('qrCode') as string;

    const qrCodeImage = await QRCode.toDataURL(qrCode);
    res.send(`<img src="${qrCodeImage}" alt="QR Code"/>`);
  });


  server.listen(port, () => {
  });
  return server
}

