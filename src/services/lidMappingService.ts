import { WASocket, BufferJSON } from "baileys";
import { jidDecode, isLidUser } from "baileys";
import type { Database as DB } from "better-sqlite3";
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

/**
 * Grava o par lid/phone no mapeamento global. Um lid pode passar a apontar
 * para outro telefone (ex: número reatribuído, conta recriada), então toda
 * atualização recebida (evento `lid-mapping.update`, resolução nativa do
 * Baileys, etc) sobrescreve o valor existente em vez de manter o primeiro.
 */
export async function storeLidMapping(lid: string, phone: string): Promise<void> {
  const existing = await LidMapping.findByPk(lid);
  if (existing && existing.get("phone") !== phone) {
    log.info(
      `LID mapping para ${lid} mudou: ${existing.get("phone")} -> ${phone}. Sobrescrevendo.`,
    );
  }
  await LidMapping.upsert({ lid, phone });
}

export async function isLidResolved(lid: string): Promise<boolean> {
  return (await LidMapping.findByPk(lid)) !== null;
}

const LID_IMPORT_PAGE_SIZE = 200;

type LidImportJob = { db: DB; sessionId: string };

const lidImportQueue: LidImportJob[] = [];
let lidImportWorkerRunning = false;

/**
 * Enfileira a importação dos mapeamentos lid/pn do auth state sqlite de uma
 * sessão para o mapeamento global (LidMapping). Não bloqueia: a leitura é
 * paginada e roda em background por um único worker, um item da fila por
 * vez, para nunca competir com outras queries pela conexão do sqlite
 * principal (pool max=1) por muito tempo de uma vez.
 */
export function queueLidMappingImport(db: DB, sessionId: string): void {
  lidImportQueue.push({ db, sessionId });
  log.info(`Sessão ${sessionId}: importação de mapeamentos lid enfileirada`);
  if (!lidImportWorkerRunning) {
    lidImportWorkerRunning = true;
    runLidImportWorker().finally(() => {
      lidImportWorkerRunning = false;
    });
  }
}

async function runLidImportWorker(): Promise<void> {
  let job: LidImportJob | undefined;
  while ((job = lidImportQueue.shift())) {
    await importLidMappingsFromAuthState(job.db, job.sessionId);
  }
}

async function importLidMappingsFromAuthState(
  db: DB,
  sessionId: string,
): Promise<void> {
  log.info(`Sessão ${sessionId}: iniciando importação de mapeamentos lid do auth state`);

  // Range scan direto pela primary key (id) em vez de LIKE 'prefix%': o id é
  // indexado (é a PK), então `id > cursor AND id < upperBound` usa o índice
  // como um cursor sequencial, bem mais rápido que varrer com LIKE.
  const prefix = `baileys-auth-state:${sessionId}:lid-mapping-`;
  const upperBound = prefix + "￿";
  const pageStmt = db.prepare(
    "SELECT id, value FROM BaileysAuth WHERE id > ? AND id < ? ORDER BY id LIMIT ?",
  );

  let cursor = prefix;
  let totalFound = 0;
  let totalInserted = 0;
  while (true) {
    const rows = pageStmt.all(cursor, upperBound, LID_IMPORT_PAGE_SIZE) as {
      id: string;
      value: string;
    }[];
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const pairs = new Map<string, string>();
    for (const row of rows) {
      if (row.id.endsWith("_reverse")) continue;
      const pnUser = row.id.slice(prefix.length);
      if (!pnUser) continue;
      const lidUser = JSON.parse(row.value, BufferJSON.reviver);
      if (typeof lidUser !== "string" || !lidUser) continue;

      const phone = pnUser.replace(/[^\d]/g, "");
      if (!phone) continue;
      pairs.set(`${lidUser}@lid`, phone);
    }
    totalFound += pairs.size;

    if (pairs.size > 0) {
      const existing = await LidMapping.findAll({
        where: { lid: [...pairs.keys()] },
        attributes: ["lid"],
      });
      const existingLids = new Set(existing.map((row) => row.get("lid") as string));

      const toInsert = [...pairs.entries()]
        .filter(([lid]) => !existingLids.has(lid))
        .map(([lid, phone]) => ({ lid, phone }));

      if (toInsert.length > 0) {
        log.info(
          `Sessão ${sessionId}: inserindo ${toInsert.length} novos mapeamentos lid (página até ${cursor})`,
        );
        await LidMapping.bulkCreate(toInsert, { ignoreDuplicates: true });
        totalInserted += toInsert.length;
      }
    }

    if (rows.length < LID_IMPORT_PAGE_SIZE) break;
  }

  log.info(
    `Sessão ${sessionId}: importação de mapeamentos lid concluída (${totalFound} encontrados, ${totalInserted} inseridos)`,
  );
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
