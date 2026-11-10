import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnyMessageContent, WAMessage } from "@whiskeysockets/baileys";
import type { BaileysConnection } from "@/baileys/connection";

interface Format {
  format_id: string;
  height?: number | null;
  ext?: string;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  abr?: number | null;
  audio_channels?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
}
interface VideoInfo {
  title?: string;
  formats?: Format[];
}

const root = resolve(import.meta.dir, "../..");
const configuredTools = process.env.YOUTUBE_TOOLS_DIR?.trim();
const toolsDir = configuredTools ? resolve(configuredTools) : join(root, "vendor");
const ytdlp = process.env.YTDLP_PATH?.trim() || join(toolsDir, "yt-dlp");
const workDir = resolve(process.env.YOUTUBE_OUTPUT_DIR?.trim() || join(root, "youtube-downloads"));
const activeJobs = new Set<string>();

async function ensureDownloadTools(): Promise<void> {
  if (!existsSync(ytdlp)) throw new Error(`لم يتم العثور على yt-dlp في ${ytdlp}.`);
  await mkdir(toolsDir, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"] as const) {
    const binary = join(toolsDir, name);
    if (existsSync(binary)) continue;
    const partsDir = join(root, "vendor", "parts");
    const parts = (await readdir(partsDir))
      .filter((file) => file.startsWith(`${name}.part-`))
      .sort()
      .map((file) => join(partsDir, file));
    if (!parts.length) throw new Error(`الأداة ${name} أو أجزاؤها غير موجودة.`);
    const process = Bun.spawn(["cat", ...parts], { stdout: "pipe", stderr: "pipe" });
    const [bytes, stderr] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
    ]);
    if (await process.exited) throw new Error(`تعذر تجميع ${name}: ${stderr}`);
    await Bun.write(binary, bytes);
    await (await import("node:fs/promises")).chmod(binary, 0o755);
  }
}

function safeYouTubeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      ![
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
      ].includes(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function run(
  args: string[],
  timeoutMs = 15 * 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([ytdlp, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${toolsDir}:${process.env.PATH ?? ""}` },
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function bytesLabel(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes < 0) return "الحجم الدقيق غير متاح من المصدر";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]} (${bytes.toLocaleString("en-US")} بايت)`;
}

function getText(message: WAMessage): string | null {
  const m = message.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

function listFormats(info: VideoInfo) {
  const formats = info.formats ?? [];
  const videos = new Map<number, Format>();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === "none") continue;
    const old = videos.get(f.height);
    if (
      !old ||
      (typeof f.filesize === "number" && typeof old.filesize !== "number") ||
      (f.acodec !== "none" && old.acodec === "none")
    )
      videos.set(f.height, f);
  }
  const video = [...videos.values()].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  const audios = formats
    .filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
    .sort((a, b) => (a.abr ?? 0) - (b.abr ?? 0));
  const audioByRate = new Map<number, Format>();
  for (const f of audios) {
    const rate = Math.round(f.abr ?? 0);
    const old = audioByRate.get(rate);
    if (!old || (typeof f.filesize === "number" && typeof old.filesize !== "number"))
      audioByRate.set(rate, f);
  }
  return { videos, video, audio: [...audioByRate.values()] };
}

export async function handleYouTubeCommand(
  connection: BaileysConnection,
  message: WAMessage,
): Promise<boolean> {
  if (message.key.fromMe) return false;
  const text = getText(message);
  if (!text || !/^\/y(?:\s|$)/i.test(text)) return false;
  const jid = message.key.remoteJid;
  if (!jid) return true;
  const reply = (body: string, extra: Partial<AnyMessageContent> = {}) =>
    connection.sendMessage(jid, { text: body, ...extra }, { quoted: message });
  const args = text.trim().split(/\s+/);
  try {
    if (args.length === 2) {
      const url = safeYouTubeUrl(args[1] ?? "");
      if (!url) {
        await reply("صيغة الأمر: /y رابط_يوتيوب");
        return true;
      }
      await reply("جارٍ فحص الفيديو واستخراج الجودات والأحجام الدقيقة…");
      const result = await run(
        ["--dump-single-json", "--no-playlist", "--no-warnings", url],
        90_000,
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || "تعذّر جلب معلومات الفيديو.");
      const info = JSON.parse(result.stdout) as VideoInfo;
      const choices = listFormats(info);
      rememberYouTubeChoices(connection, jid, url, info);
      if (!choices.video.length) throw new Error("لم يعثر yt-dlp على جودات فيديو قابلة للتنزيل.");
      const lines = [`🎞️ ${info.title ?? "الفيديو"}`, "", "جودات الفيديو:"];
      choices.video.forEach((f, i) => {
        lines.push(
          `${i + 1}. ${f.height}p${f.fps ? ` / ${f.fps}fps` : ""} — ${bytesLabel(f.filesize)}`,
        );
      });
      lines.push("", "جودات الصوت:");
      lines.push("0. بدون صوت");
      choices.audio.forEach((f, i) => {
        lines.push(`${i + 1}. ${Math.round(f.abr ?? 0)} kbps — ${bytesLabel(f.filesize)}`);
      });
      lines.push(
        "",
        "للتنزيل أرسل: /y رقم_الفيديو رقم_الصوت",
        "مثال: /y 2 0 — الجودة الثانية دون صوت",
      );
      lines.push(
        "الأحجام المعروضة هي أحجام yt-dlp الدقيقة فقط؛ عند غيابها يظهر أنها غير متاحة ولا يُستخدم الحجم التقريبي.",
      );
      await reply(lines.join("\n"));
      return true;
    }
    if (args.length !== 3 || !/^\d+$/.test(args[1] ?? "") || !/^\d+$/.test(args[2] ?? "")) {
      await reply(
        "الصيغة: /y رابط ثم /y رقم_جودة_الفيديو رقم_جودة_الصوت. استخدم 0 للصوت لاستبعاده.",
      );
      return true;
    }
    const videoIndex = Number(args[1]),
      audioIndex = Number(args[2]);
    if (videoIndex < 1) {
      await reply("رقم جودة الفيديو يبدأ من 1؛ الرقم 0 مخصص لاستبعاد الصوت فقط.");
      return true;
    }
    const previous = (
      connection as unknown as {
        youtubeChoices?: Map<
          string,
          { url: string; videoIds: string[]; audioIds: string[]; title: string }
        >;
      }
    ).youtubeChoices;
    const cached = previous?.get(jid);
    if (!cached) {
      await reply("لم أجد قائمة جودات سابقة لهذه المحادثة. أرسل /y رابط_يوتيوب أولًا.");
      return true;
    }
    if (videoIndex > cached.videoIds.length || audioIndex > cached.audioIds.length) {
      await reply("رقم الجودة خارج القائمة المعروضة. أرسل /y رابط_يوتيوب لإظهار القائمة مجددًا.");
      return true;
    }
    if (activeJobs.has(jid)) {
      await reply("يوجد تنزيل جارٍ في هذه المحادثة؛ انتظر حتى يكتمل.");
      return true;
    }
    activeJobs.add(jid);
    await reply("بدأ التنزيل. سأرسل الملف عند اكتماله.");
    void downloadAndSend(connection, jid, message, cached, videoIndex - 1, audioIndex - 1)
      .catch(async (error) => {
        await connection
          .sendMessage(jid, {
            text: `فشل التنزيل: ${error instanceof Error ? error.message : String(error)}`,
          })
          .catch(() => {});
      })
      .finally(() => activeJobs.delete(jid));
    return true;
  } catch (error) {
    await reply(
      `تعذّر تنفيذ الأمر: ${error instanceof Error ? error.message.slice(0, 700) : String(error)}`,
    );
    return true;
  }
}

async function downloadAndSend(
  connection: BaileysConnection,
  jid: string,
  quoted: WAMessage,
  cached: { url: string; videoIds: string[]; audioIds: string[]; title: string },
  vi: number,
  ai: number,
): Promise<void> {
  await ensureDownloadTools();
  await mkdir(workDir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(workDir, id);
  await mkdir(dir, { recursive: true });
  const videoFormat = cached.videoIds[vi];
  const audioFormat = ai > 0 ? cached.audioIds[ai - 1] : undefined;
  if (!videoFormat || (ai > 0 && !audioFormat)) throw new Error("الخيار المحدد غير متوفر.");
  const format = ai === 0 ? videoFormat : `${videoFormat}+${audioFormat}`;
  const result = await run([
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--format",
    format,
    "--merge-output-format",
    "mp4",
    "--output",
    join(dir, "%(title).140B-%(id)s.%(ext)s"),
    cached.url,
  ]);
  try {
    if (result.code !== 0) throw new Error(result.stderr.trim().slice(-900) || "فشل yt-dlp.");
    const files = (await readdir(dir)).filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"));
    const file = files[0];
    if (!file) throw new Error("اكتمل الأمر لكن لم يُعثر على ملف الناتج.");
    const path = join(dir, file);
    const size = (await stat(path)).size;
    if (size > 1_900_000_000)
      throw new Error("حجم الملف أكبر من الحد الآمن للإرسال كوسائط واتساب.");
    const ext = file.split(".").pop()?.toLowerCase() ?? "bin";
    const mime =
      ext === "mp4" ? "video/mp4" : ext === "webm" ? "video/webm" : "application/octet-stream";
    const data = await Bun.file(path).arrayBuffer();
    const content: AnyMessageContent = {
      document: Buffer.from(data),
      mimetype: mime,
      fileName: file,
      caption: `اكتمل التنزيل — ${bytesLabel(size)}`,
    };
    await connection.sendMessage(jid, content, { quoted });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function rememberYouTubeChoices(
  connection: BaileysConnection,
  jid: string,
  url: string,
  info: VideoInfo,
): void {
  const { video, audio } = listFormats(info);
  const store = connection as unknown as { youtubeChoices?: Map<string, unknown> };
  if (!store.youtubeChoices) store.youtubeChoices = new Map();
  (store.youtubeChoices as Map<string, unknown>).set(jid, {
    url,
    videoIds: video.map((f) => f.format_id),
    audioIds: audio.map((f) => f.format_id),
    title: info.title ?? "video",
  });
}
