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
const ytdlp = process.env.YTDLP_PATH?.trim() || join(root, "vendor", "yt-dlp");
const workDir = resolve(process.env.YOUTUBE_OUTPUT_DIR?.trim() || join(root, "youtube-downloads"));
const cookiesPath = process.env.YOUTUBE_COOKIES_FILE?.trim()
  ? resolve(process.env.YOUTUBE_COOKIES_FILE.trim())
  : "";
const activeJobs = new Set<string>();

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
  if (cookiesPath && !existsSync(cookiesPath)) {
    throw new Error(`ملف cookies المحدد غير موجود: ${cookiesPath}`);
  }
  const ytDlpArgs = cookiesPath ? ["--cookies", cookiesPath, ...args] : args;
  const child = Bun.spawn([ytdlp, ...ytDlpArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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

interface VideoChoice {
  height: number;
  withAudio?: Format;
  videoOnly?: Format;
}

function listFormats(info: VideoInfo) {
  const videos = new Map<number, VideoChoice>();
  for (const f of info.formats ?? []) {
    if (!f.height || !f.vcodec || f.vcodec === "none") continue;
    const choice = videos.get(f.height) ?? { height: f.height };
    const hasAudio = Boolean(f.acodec && f.acodec !== "none");
    const existing = hasAudio ? choice.withAudio : choice.videoOnly;
    if (!existing || (typeof f.filesize === "number" && typeof existing.filesize !== "number")) {
      if (hasAudio) choice.withAudio = f;
      else choice.videoOnly = f;
    }
    videos.set(f.height, choice);
  }
  const video = [...videos.values()].sort((a, b) => a.height - b.height);
  return { video };
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
      choices.video.forEach((choice, i) => {
        const audioSize = choice.withAudio
          ? bytesLabel(choice.withAudio.filesize)
          : "غير متاح كملف واحد";
        const silentSize = choice.videoOnly
          ? bytesLabel(choice.videoOnly.filesize)
          : "غير متاح كملف صامت";
        lines.push(
          `${i + 1}. ${choice.height}p — مع الصوت: ${audioSize} — بدون صوت: ${silentSize}`,
        );
      });
      lines.push("", "جودات الصوت:");
      lines.push("0. بدون صوت");
      lines.push("1. الصوت المدمج في صيغة الفيديو (بدون دمج خارجي)");
      lines.push(
        "",
        "للتنزيل أرسل: /y رقم_الفيديو رقم_الصوت",
        "مثال: /y 2 0 — الجودة الثانية دون صوت. استخدم 1 لإرفاق صوت مدمج إن توفر.",
      );
      lines.push(
        "الأحجام المعروضة هي أحجام yt-dlp الدقيقة فقط؛ عند غيابها يظهر أنها غير متاحة ولا يُستخدم الحجم التقريبي.",
      );
      await reply(lines.join("\n"));
      return true;
    }
    if (args.length !== 3 || !/^\d+$/.test(args[1] ?? "") || !/^\d+$/.test(args[2] ?? "")) {
      await reply(
        "الصيغة: /y رابط ثم /y رقم_جودة_الفيديو رقم_الصوت. استخدم 0 بدون صوت أو 1 للصوت المدمج.",
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
          {
            url: string;
            videoIds: string[];
            videoHeights: number[];
            title: string;
          }
        >;
      }
    ).youtubeChoices;
    const cached = previous?.get(jid);
    if (!cached) {
      await reply("لم أجد قائمة جودات سابقة لهذه المحادثة. أرسل /y رابط_يوتيوب أولًا.");
      return true;
    }
    if (videoIndex > cached.videoIds.length || audioIndex > 1) {
      await reply("رقم الجودة خارج القائمة المعروضة. أرسل /y رابط_يوتيوب لإظهار القائمة مجددًا.");
      return true;
    }
    if (activeJobs.has(jid)) {
      await reply("يوجد تنزيل جارٍ في هذه المحادثة؛ انتظر حتى يكتمل.");
      return true;
    }
    activeJobs.add(jid);
    await reply("بدأ التنزيل. سأرسل الملف عند اكتماله.");
    void downloadAndSend(connection, jid, message, cached, videoIndex - 1, audioIndex)
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
  cached: {
    url: string;
    videoIds: string[];
    videoHeights: number[];
    title: string;
  },
  vi: number,
  ai: number,
): Promise<void> {
  await mkdir(workDir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(workDir, id);
  await mkdir(dir, { recursive: true });
  try {
    // Refresh formats immediately before downloading. YouTube format IDs may
    // change or disappear between listing and selection.
    const refreshed = await run(
      ["--dump-single-json", "--no-playlist", "--no-warnings", cached.url],
      90_000,
    );
    if (refreshed.code !== 0)
      throw new Error(refreshed.stderr.trim().slice(-900) || "تعذر تحديث صيغ الفيديو.");
    const info = JSON.parse(refreshed.stdout) as VideoInfo;
    const videoHeight = cached.videoHeights[vi];
    if (!videoHeight)
      throw new Error("الخيار المحدد غير متوفر؛ أرسل رابط الفيديو مجددًا لعرض الجودات الحالية.");
    const output = join(dir, "%(title).140B-%(id)s.%(ext)s");
    const commonArgs = ["--no-playlist", "--no-warnings", "--no-progress", "--output", output];
    const singleFileFormats = (info.formats ?? []).filter(
      (format) => format.height === videoHeight && format.vcodec && format.vcodec !== "none",
    );
    const selectedFormat =
      ai === 0
        ? singleFileFormats.find((format) => !format.acodec || format.acodec === "none")
        : singleFileFormats.find((format) => format.acodec && format.acodec !== "none");
    if (!selectedFormat) {
      throw new Error(
        ai === 0
          ? "لا تتوفر صيغة فيديو فقط لهذه الدقة. أرسل /y الرابط واختر دقة أخرى."
          : "لا تتوفر لهذه الدقة صيغة واحدة تحتوي الفيديو والصوت. اختر جودة أخرى؛ لم يعد المشروع يدمج مسارات منفصلة.",
      );
    }
    let result = await run(["--format", selectedFormat.format_id, ...commonArgs, cached.url]);
    if (
      result.code !== 0 &&
      /requested format is not available|requested format not available/i.test(result.stderr)
    ) {
      // Retry using a single-file semantic selector; never invoke an external merger.
      const selector =
        ai === 0 ? `bestvideo[height=${videoHeight}]` : `best[height=${videoHeight}]`;
      result = await run(["--format", selector, ...commonArgs, cached.url]);
    }
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
  const { video } = listFormats(info);
  const store = connection as unknown as { youtubeChoices?: Map<string, unknown> };
  if (!store.youtubeChoices) store.youtubeChoices = new Map();
  (store.youtubeChoices as Map<string, unknown>).set(jid, {
    url,
    videoIds: video.map((choice) => String(choice.height)),
    videoHeights: video.map((choice) => choice.height),
    title: info.title ?? "video",
  });
}
