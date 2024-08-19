import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

import ClientModel from '../models/client'



export async function createClient(clientId: string) {
    const clientModel = await ClientModel.create({
        clientId: clientId
    })
    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './data/',
            clientId: clientId
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    client.on('remote_session_saved', () => {
        clientModel.set({
            ready: true
        })
        clientModel.save();
    });
    
    client.on('qr', (qr) => {
        clientModel.set({
            qrCode: qr
        })
        clientModel.save();
    });
    
    client.on('ready', () => {
        clientModel.set({
            ready: true
        })
        clientModel.save();
    });
    
    client.on('message', msg => {
        switch(msg.type.toUpperCase()){
            case 'TEXT':
                if (msg.body == '!ping') {
                    msg.reply('pong: '+msg.from);
                }
                break;
            case 'AUDIO':
            case 'VOICE':
            case 'IMAGE':
            case 'VIDEO':
            case 'DOCUMENT':
            case 'STICKER':
            case 'LOCATION':
            case 'GROUP_INVITE':
            case 'BUTTONS_RESPONSE':
            case 'PAYMENT':
            case 'GROUP_NOTIFICATION':
            case 'NOTIFICATION':
                console.log(msg)
                break;
            default:
                break;
        }

    });
    
    client.initialize();
    return clientModel;
}

