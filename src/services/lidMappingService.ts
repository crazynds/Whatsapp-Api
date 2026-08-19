import { WASocket } from "baileys";
import { jidDecode, isLidUser } from "baileys";
import log from "../lib/logger";
import LidMapping from "../models/lidMapping";

export function jidToPhoneDigits(jid: string): string {
  return (jidDecode(jid)?.user ?? jid.split("@")[0] ?? "").replace(/[^\d]/g, "");
}

export type ResolvedSender =
  | { resolved: true; phone: string }
  | { resolved: false; lid: string };

/**
 * Resolve um jid de remetente para o telefone real.
 * - Se não for lid (`@lid`), já é o telefone: retorna direto, resolvido.
 * - Se for lid: tenta 1) o mapeamento global (tabela LidMapping), depois
 *   2) o lidMapping nativo do Baileys (signalRepository); se a lib resolver,
 *   grava no mapeamento global antes de retornar.
 * - Se nenhum dos dois resolver, retorna `{ resolved: false, lid }` — quem
 *   chamar decide o que fazer (ex: mandar pro webhook mesmo assim, marcado
 *   como lid, sem telefone).
 */
export async function resolveSenderJid(
  sock: WASocket,
  jid: string,
): Promise<ResolvedSender> {
  if (!isLidUser(jid)) {
    return { resolved: true, phone: jidToPhoneDigits(jid) };
  }

  const cached = await LidMapping.findByPk(jid);
  if (cached) {
    return { resolved: true, phone: cached.get("phone") as string };
  }

  const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid);
  if (!pnJid) {
    return { resolved: false, lid: jid };
  }

  const phone = jidToPhoneDigits(pnJid);
  await storeLidMapping(jid, phone);
  return { resolved: true, phone };
}

export async function storeLidMapping(lid: string, phone: string): Promise<void> {
  const [row, created] = await LidMapping.findOrCreate({
    where: { lid },
    defaults: { lid, phone },
  });
  if (!created && row.get("phone") !== phone) {
    log.warn(
      `LID mapping mismatch for ${lid}: had ${row.get("phone")}, resolved ${phone}. Keeping first value.`,
    );
  }
}

export async function isLidResolved(lid: string): Promise<boolean> {
  return (await LidMapping.findByPk(lid)) !== null;
}

// Cooldown em memória para não ficar reenviando `requestPhoneNumber` a cada
// mensagem enviada pro mesmo lid ainda não resolvido.
const lastPhoneNumberRequestAt = new Map<string, number>();
const REQUEST_PHONE_NUMBER_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

export function shouldRequestPhoneNumber(lid: string): boolean {
  const last = lastPhoneNumberRequestAt.get(lid);
  if (last && Date.now() - last < REQUEST_PHONE_NUMBER_COOLDOWN_MS) {
    return false;
  }
  lastPhoneNumberRequestAt.set(lid, Date.now());
  return true;
}
