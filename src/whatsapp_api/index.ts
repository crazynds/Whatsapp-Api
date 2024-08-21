import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

import ClientModel from '../models/client'
import { Model } from '@sequelize/core';

export const clients = {
} as {
    [key: string]: Client
}


export async function sendMessage(model: Model<any,any>, chatId: string, message: string){
    const clientId = model.get('clientId') as string | null;
    const client = clients[ clientId ?? ''];
    if(!client) return false;

    const chat = await client.getChatById(chatId);

    if(!chat) return false;

    const msg = await chat.sendMessage(message,{});
    const infos = await msg.getInfo();
    return {
        'id': msg.id._serialized,
        'author': msg.fromMe ? null : (chat.isGroup ? msg.author : chat.name),
        'body': msg.body,
        'type': msg.type,
        'info': infos ? {
            'deliverd': infos.delivery.length > 0,
            'read': infos.read.length > 0,
            'played': infos.played.length > 0
        } : {},
        'isForwarded': msg.isForwarded,
        'timestamp': new Date(msg.timestamp * 1000),
    }
}
export async function getChats(model: Model<any,any>){
    const clientId = model.get('clientId') as string | null;
    const client = clients[ clientId ?? ''];
    if(!client) return false;

    return (await client.getChats()).map(chat => {
        return {
            'id': chat.id._serialized,
            'name': chat.name,
            'unreadCount': chat.unreadCount,
            'isArchived': chat.archived,
            'isGroup': chat.isGroup,
            'isMuted': chat.isMuted,
            'isReadOnly': chat.isReadOnly,
            'isPinned': chat.pinned,
        }
    });
}
export async function getChatMessages(model: Model<any,any>, chatId: string, count: number){
    const clientId = model.get('clientId') as string | null;
    const client = clients[ clientId ?? ''];
    if(!client) return false;
    const chat = await client.getChatById(chatId);
    if(!chat) return false;
    return (await chat.fetchMessages({
        limit: count
    })).forEach(async msg => {
        const infos = await msg.getInfo();
        return {
            'id': msg.id._serialized,
            'author': msg.fromMe ? null : (chat.isGroup ? msg.author : chat.name),
            'body': msg.body,
            'type': msg.type,
            'info': infos ? {
                'deliverd': infos.delivery.length > 0,
                'read': infos.read.length > 0,
                'played': infos.played.length > 0

            } : {},
            'isForwarded': msg.isForwarded,
            'timestamp': new Date(msg.timestamp * 1000),
        }
    });
}


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
    clients[clientId] = client
    return clientModel;
}

