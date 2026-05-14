require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { google } = require('googleapis');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const {
  DISCORD_TOKEN,
  SPREADSHEET_ID,
  SHEET_RANGE,
  DEFAULT_CHANNEL_ID,
  NOTIFY_MINUTES_BEFORE,
  TIMEZONE,
} = process.env;

const TZ = TIMEZONE || 'Asia/Tokyo';
function getNotifyBeforeMinutes() {
  const minutes = Number(process.env.NOTIFY_MINUTES_BEFORE || 30);

  if (Number.isNaN(minutes) || minutes <= 0) {
    return 30;
  }

  return minutes;
}

function isTrainInfoEnabled() {
  return process.env.TRAIN_INFO_ENABLED === 'true';
}

function getTrainLineName() {
  return process.env.TRAIN_LINE_NAME || '山手線';
}

function getTrainInfoUrl() {
  return process.env.TRAIN_INFO_URL || 'https://transit.yahoo.co.jp/diainfo/21/0';
}

function isQuietHoursEnabled() {
  return process.env.QUIET_HOURS_ENABLED === 'true';
}

function getQuietHoursStart() {
  return process.env.QUIET_HOURS_START || '20:00';
}

function getQuietHoursEnd() {
  return process.env.QUIET_HOURS_END || '06:00';
}

function timeToMinutes(timeText) {
  const [hourText, minuteText] = String(timeText || '00:00').split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return 0;
  }

  return hour * 60 + minute;
}

function isInQuietHours(now = dayjs().tz(TZ)) {
  if (!isQuietHoursEnabled()) {
    return false;
  }

  const currentMinutes = now.hour() * 60 + now.minute();
  const startMinutes = timeToMinutes(getQuietHoursStart());
  const endMinutes = timeToMinutes(getQuietHoursEnd());

  // 例: 20:00〜06:00 のように日付をまたぐ場合
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  // 例: 01:00〜05:00 のように同日内の場合
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function getTrainInfoChannelId() {
  return process.env.TRAIN_INFO_CHANNEL_ID || DEFAULT_CHANNEL_ID;
}

function getTrainCheckIntervalMinutes() {
  const minutes = Number(process.env.TRAIN_CHECK_INTERVAL_MINUTES || 5);

  if (Number.isNaN(minutes) || minutes <= 0) {
    return 5;
  }

  return Math.min(minutes, 60);
}

function shouldNotifyNormalTrainStatus() {
  return process.env.TRAIN_NOTIFY_NORMAL === 'true';
}

function createHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function getDailySummaryTime() {
  return process.env.DAILY_SUMMARY_TIME || '07:00';
}

function normalizeDateText(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const formats = [
    'YYYY/M/D',
    'YYYY/MM/DD',
    'YYYY-M-D',
    'YYYY-MM-DD',
    'YYYY年M月D日',
  ];

  for (const format of formats) {
    const parsed = dayjs(text, format, true);

    if (parsed.isValid()) {
      return parsed.format('YYYY-MM-DD');
    }
  }

  return text;
}

function normalizeTimeText(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const formats = [
    'H:mm',
    'HH:mm',
    'H:mm:ss',
    'HH:mm:ss',
  ];

  for (const format of formats) {
    const parsed = dayjs(text, format, true);

    if (parsed.isValid()) {
      return parsed.format('HH:mm');
    }
  }

  return text;
}

function isSameMinute(a, b) {
  return a.format('YYYY-MM-DD HH:mm') === b.format('YYYY-MM-DD HH:mm');
}

const SENT_FILE = process.env.SENT_FILE || path.join(__dirname, 'sent.json');

let classCache = [];
let lastLoadedAt = null;
let isCheckingSchedule = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function getErrorMessage(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.errors?.[0]?.message ||
    error?.message ||
    String(error)
  );
}

function getDiscordErrorCode(error) {
  return error?.code || error?.rawError?.code;
}

function isUnknownChannelError(error) {
  return getDiscordErrorCode(error) === 10003;
}

function normalizeChannelId(channelId) {
  return String(channelId || '').trim();
}

async function getNotificationChannel(channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);

  if (!normalizedChannelId) {
    return {
      ok: false,
      reason: '通知先チャンネルIDが空だわん…',
      channel: null,
    };
  }

  if (!/^\d{17,20}$/.test(normalizedChannelId)) {
    return {
      ok: false,
      reason: `通知先チャンネルIDの形式が変だわん…: ${normalizedChannelId}`,
      channel: null,
    };
  }

  try {
    const channel = await client.channels.fetch(normalizedChannelId);

    if (!channel) {
      return {
        ok: false,
        reason: `チャンネルが見つからないわん…: ${normalizedChannelId}`,
        channel: null,
      };
    }

    if (!channel.isTextBased()) {
      return {
        ok: false,
        reason: `このチャンネルにはメッセージを送れないわん…: ${normalizedChannelId}`,
        channel: null,
      };
    }

    return {
      ok: true,
      reason: '',
      channel,
    };
  } catch (error) {
    if (isUnknownChannelError(error)) {
      return {
        ok: false,
        reason: `Unknown Channelだわん… チャンネルが存在しない、削除済み、またはBotから見えていない可能性があるわん: ${normalizedChannelId}`,
        channel: null,
      };
    }

    return {
      ok: false,
      reason: `チャンネル取得に失敗したわん…: ${getErrorMessage(error)}`,
      channel: null,
    };
  }
}

function loadSent() {
  try {
    if (!fs.existsSync(SENT_FILE)) {
      fs.writeFileSync(SENT_FILE, JSON.stringify({}, null, 2));
      return {};
    }

    const text = fs.readFileSync(SENT_FILE, 'utf8').trim();

    if (!text) {
      fs.writeFileSync(SENT_FILE, JSON.stringify({}, null, 2));
      return {};
    }

    return JSON.parse(text);
  } catch (error) {
    console.error('sent.json の読み込みに失敗したため、空で初期化するわん');
    console.error(getErrorMessage(error));

    fs.writeFileSync(SENT_FILE, JSON.stringify({}, null, 2));
    return {};
  }
}

function saveSent(sent) {
  fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2));
}

function resetTrainInfoState() {
  const sent = loadSent();
  let deletedCount = 0;

  for (const key of Object.keys(sent)) {
    if (key.startsWith('train_info_')) {
      delete sent[key];
      deletedCount++;
    }
  }

  saveSent(sent);

  console.log(`山手線運行情報の通知状態をリセットしたわん: ${deletedCount}件`);

  return deletedCount;
}

function getGoogleCredentialsPath() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (envPath) {
    return path.isAbsolute(envPath)
      ? envPath
      : path.join(__dirname, envPath);
  }

  return path.join(__dirname, 'credentials.json');
}

async function getSheetsClient() {
  if (!SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID が設定されていないわん。Renderまたは.envを確認してくれわん。');
  }

  const credentialsPath = getGoogleCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Google認証ファイルが見つからないわん: ${credentialsPath}\n` +
      `ローカルの場合は credentials.json をプロジェクト直下に置いてくれわん。\n` +
      `Renderの場合は Secret File に credentials.json を追加し、GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/credentials.json を設定してわん。`
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({
    version: 'v4',
    auth,
  });
}

async function fetchClasses() {
  try {
    const sheets = await getSheetsClient();

    const range = SHEET_RANGE || '授業!A2:G';

    console.log('Google Sheets 読み込み開始だわん');
    console.log(`SPREADSHEET_ID: ${SPREADSHEET_ID}`);
    console.log(`SHEET_RANGE: ${range}`);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    const rows = res.data.values || [];

    console.log(`Google Sheets 読み込み成功したわん: ${rows.length}行`);

    return rows
      .filter((row) => row && row.some((cell) => cell !== undefined && cell !== ''))
      .map((row) => {
        const [
          date,
          start,
          end,
          subject,
          room,
          teacher,
          channelId,
        ] = row;

        return {
          date: normalizeDateText(date),
          start: normalizeTimeText(start),
          end: normalizeTimeText(end),
          subject: String(subject || '').trim(),
          room: String(room || '').trim(),
          teacher: String(teacher || '').trim(),
          channelId: normalizeChannelId(channelId || DEFAULT_CHANNEL_ID || ''),
        };
      });
  } catch (error) {
    console.error('Google Sheets の取得に失敗しちゃったわん');
    console.error(getErrorMessage(error));
    throw error;
  }
}

async function reloadClasses() {
  try {
    classCache = await fetchClasses();
    lastLoadedAt = dayjs().tz(TZ);

    console.log(`スプレッドシートを再読み込みしたわん: ${classCache.length}件`);

    return classCache;
  } catch (error) {
    console.error('reloadClasses でエラーが発生しましたわん');
    console.error(getErrorMessage(error));
    throw error;
  }
}

function isTrainNotifyOnlyClassDays() {
  return process.env.TRAIN_NOTIFY_ONLY_CLASS_DAYS === 'true';
}

function isDailySummaryOnlyClassDays() {
  return process.env.DAILY_SUMMARY_ONLY_CLASS_DAYS !== 'false';
}

function hasClassesOnDate(classes, targetDate) {
  const normalizedTargetDate = normalizeDateText(targetDate);

  return classes.some((classInfo) => {
    return (
      normalizeDateText(classInfo.date) === normalizedTargetDate &&
      String(classInfo.subject || '').trim() !== ''
    );
  });
}

async function getClasses() {
  if (!classCache || classCache.length === 0) {
    return await reloadClasses();
  }

  return classCache;
}

function createClassKey(classInfo) {
  return `${classInfo.date}_${classInfo.start}_${classInfo.subject}_${classInfo.channelId}`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<!--.*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isTrainTroubleStatus(statusText) {
  const text = String(statusText || '');

  return !(
    text.includes('平常') ||
    text.includes('通常') ||
    text.includes('現在､事故･遅延に関する情報はありません')
  );
}

async function fetchTrainInfo() {
  const url = getTrainInfoUrl();
  const lineName = getTrainLineName();

  console.log(`${lineName} 運行情報を取得中...`);
  console.log(`URL: ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 DiscordBot TrainInfoChecker',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`運行情報ページの取得に失敗しました: HTTP ${res.status}`);
  }

  const html = await res.text();

  const updateMatch = html.match(/<span class="subText">([\s\S]*?)<\/span>/);
  const updatedAt = updateMatch ? stripHtml(updateMatch[1]) : '更新時刻不明';

  const statusBlockMatch = html.match(/<div id="mdServiceStatus">([\s\S]*?)<\/div>\s*<div/);
  const statusBlock = statusBlockMatch ? statusBlockMatch[1] : html;

  const statusMatch = statusBlock.match(/<dt[^>]*>([\s\S]*?)<\/dt>/);
  const status = statusMatch ? stripHtml(statusMatch[1]) : '状態不明';

  const messageMatch = statusBlock.match(/<dd[^>]*>([\s\S]*?)<\/dd>/);
  const message = messageMatch
    ? stripHtml(messageMatch[1])
    : '詳細情報を取得できませんでした。';

  const hasTrouble = isTrainTroubleStatus(status);

  return {
    lineName,
    status,
    message,
    updatedAt,
    url,
    hasTrouble,
  };
}

function createTrainInfoEmbed(trainInfo) {
  const color = trainInfo.hasTrouble ? 0xef4444 : 0x22c55e;

  return new EmbedBuilder()
    .setTitle(`${trainInfo.lineName} 運行情報`)
    .setColor(color)
    .addFields(
      {
        name: '状態',
        value: trainInfo.status || '不明',
        inline: true,
      },
      {
        name: '更新',
        value: trainInfo.updatedAt || '不明',
        inline: true,
      },
      {
        name: '詳細',
        value: trainInfo.message || '詳細なし',
      }
    )
    .setURL(trainInfo.url)
    .setFooter({
      text: '情報元: Yahoo!路線情報',
    })
    .setTimestamp();
}

async function checkTrainInfo(options = {}) {
  const force = options.force || false;
  const replyChannelId = options.channelId || null;
  const now = dayjs().tz(TZ);
  const today = now.format('YYYY-MM-DD');

  // 手動実行ではない自動通知のみ夜間制限する
  if (!force && isInQuietHours(now)) {
    console.log(`夜間時間帯のため、山手線運行情報チェックをスキップしました: ${now.format('HH:mm')}`);
    return;
  }

  if (!isTrainInfoEnabled() && !force) {
    console.log('山手線運行情報通知は無効です');
    return;
  }

  // 手動実行ではない自動通知のみ、授業がある日か確認する
  if (!force && isTrainNotifyOnlyClassDays()) {
    try {
      const classes = await reloadClasses();

      if (!hasClassesOnDate(classes, today)) {
        console.log(`授業がない日のため、山手線運行情報通知をスキップしました: ${today}`);
        return;
      }
    } catch (error) {
      console.error('授業日の確認に失敗したため、山手線運行情報通知をスキップしました');
      console.error(getErrorMessage(error));
      return;
    }
  }

  const trainInfo = await fetchTrainInfo();

  const channelId = replyChannelId || getTrainInfoChannelId();

  if (!channelId) {
    console.log('TRAIN_INFO_CHANNEL_ID または DEFAULT_CHANNEL_ID が設定されていません');
    return;
  }

  const sent = loadSent();

  // 山手線の通知状態を保存するキー
  // 既存コードとの互換性のため _last のまま使う
  const stateKey = `train_info_${trainInfo.lineName}_last`;

  const previous = sent[stateKey] || {};

  const wasTroubleAlreadyNotified =
    previous.activeTrouble === true ||
    previous.hasTrouble === true;

  const currentHash = createHash(
    JSON.stringify({
      status: trainInfo.status,
      message: trainInfo.message,
      updatedAt: trainInfo.updatedAt,
    })
  );

  const channelResult = await getNotificationChannel(channelId);

  if (!channelResult.ok) {
    console.log(`山手線運行情報の通知をスキップしました: ${channelResult.reason}`);
    return;
  }

  const channel = channelResult.channel;
  const embed = createTrainInfoEmbed(trainInfo);

  // /train など手動実行の場合は、状態に関係なく現在情報を表示する
  // ただし sent.json の通知状態は変更しない
  if (force) {
    await channel.send({
      content: `${trainInfo.lineName} の現在の運行情報わん！`,
      embeds: [embed],
      allowedMentions: {
        parse: [],
      },
    });

    console.log(`${trainInfo.lineName} の運行情報を手動送信しました: ${trainInfo.status}`);
    return;
  }

  // 遅延・運転見合わせなどがある場合
  if (trainInfo.hasTrouble) {
    // すでに遅延中として通知済みなら、何が変わっても追加送信しない
    if (wasTroubleAlreadyNotified) {
      sent[stateKey] = {
        ...previous,
        activeTrouble: true,
        hasTrouble: true,

        // 最新情報だけ保存する
        latestHash: currentHash,
        latestStatus: trainInfo.status,
        latestMessage: trainInfo.message,
        latestUpdatedAt: trainInfo.updatedAt,
        lastCheckedAt: now.format(),
      };

      saveSent(sent);

      console.log(`${trainInfo.lineName} は遅延中だけど、すでに通知済みなので送信しないわん`);
      return;
    }

    // 遅延期間の最初の1回だけ通知する
    await channel.send({
      content: `${trainInfo.lineName} に遅延や運行情報があるみたいだわん…気をつけてわん！`,
      embeds: [embed],
      allowedMentions: {
        parse: [],
      },
    });

    sent[stateKey] = {
      activeTrouble: true,
      hasTrouble: true,

      firstHash: currentHash,
      firstStatus: trainInfo.status,
      firstMessage: trainInfo.message,
      firstUpdatedAt: trainInfo.updatedAt,
      firstNotifiedAt: now.format(),

      latestHash: currentHash,
      latestStatus: trainInfo.status,
      latestMessage: trainInfo.message,
      latestUpdatedAt: trainInfo.updatedAt,
      lastCheckedAt: now.format(),
    };

    saveSent(sent);

    console.log(`${trainInfo.lineName} の遅延情報を初回通知しました: ${trainInfo.status}`);
    return;
  }

  // ここから平常時

  // 直前まで遅延中だった場合、復旧通知を1回送って状態をリセットする
  if (wasTroubleAlreadyNotified) {
    await channel.send({
      content: `${trainInfo.lineName} は平常運転に戻った可能性があるわん！よかったわん！`,
      embeds: [embed],
      allowedMentions: {
        parse: [],
      },
    });

    sent[stateKey] = {
      activeTrouble: false,
      hasTrouble: false,

      recoveredHash: currentHash,
      recoveredStatus: trainInfo.status,
      recoveredMessage: trainInfo.message,
      recoveredUpdatedAt: trainInfo.updatedAt,
      recoveredAt: now.format(),

      latestHash: currentHash,
      latestStatus: trainInfo.status,
      latestMessage: trainInfo.message,
      latestUpdatedAt: trainInfo.updatedAt,
      lastCheckedAt: now.format(),
    };

    saveSent(sent);

    console.log(`${trainInfo.lineName} の復旧通知を送信しました: ${trainInfo.status}`);
    return;
  }

  // 平常時で、まだ遅延通知もしていない場合は基本送信しない
  // TRAIN_NOTIFY_NORMAL=true の場合だけ、平常情報を送る
  if (shouldNotifyNormalTrainStatus()) {
    await channel.send({
      content: `${trainInfo.lineName} の運行情報です。`,
      embeds: [embed],
      allowedMentions: {
        parse: [],
      },
    });

    sent[stateKey] = {
      activeTrouble: false,
      hasTrouble: false,

      latestHash: currentHash,
      latestStatus: trainInfo.status,
      latestMessage: trainInfo.message,
      latestUpdatedAt: trainInfo.updatedAt,
      lastCheckedAt: now.format(),
      normalNotifiedAt: now.format(),
    };

    saveSent(sent);

    console.log(`${trainInfo.lineName} の平常情報を通知しました: ${trainInfo.status}`);
    return;
  }

  // 平常時は状態だけ保存して通知しない
  sent[stateKey] = {
    activeTrouble: false,
    hasTrouble: false,

    latestHash: currentHash,
    latestStatus: trainInfo.status,
    latestMessage: trainInfo.message,
    latestUpdatedAt: trainInfo.updatedAt,
    lastCheckedAt: now.format(),
  };

  saveSent(sent);

  console.log(`${trainInfo.lineName} は平常、または通知不要です: ${trainInfo.status}`);
}

async function notifyClass(classInfo) {
  const channelResult = await getNotificationChannel(classInfo.channelId);

  if (!channelResult.ok) {
    console.log(`授業通知をスキップしたわん: ${classInfo.subject}`);
    console.log(channelResult.reason);

    return {
      ok: false,
      reason: channelResult.reason,
    };
  }

  const channel = channelResult.channel;
  const notifyBefore = getNotifyBeforeMinutes();

  const embed = new EmbedBuilder()
    .setTitle('授業のお知らせ')
    .setColor(0x3b82f6)
    .addFields(
      {
        name: '科目',
        value: classInfo.subject || '未入力',
        inline: true,
      },
      {
        name: '時間',
        value: `${classInfo.start || '未入力'} - ${classInfo.end || '未入力'}`,
        inline: true,
      },
      {
        name: '教室',
        value: classInfo.room || '未入力',
        inline: true,
      },
      {
        name: '担当',
        value: classInfo.teacher || '未入力',
        inline: true,
      },
      {
        name: '日付',
        value: classInfo.date || '未入力',
        inline: true,
      }
    )
    .setFooter({
      text: `${notifyBefore}分前通知`,
    })
    .setTimestamp();

  await channel.send({
    content: `${notifyBefore}分後に授業があるわん！`,
    embeds: [embed],
    allowedMentions: {
      parse: [],
    },
  });

  console.log(`授業通知を送信したわん: ${classInfo.subject}`);

  return {
    ok: true,
    reason: '',
  };
}

function createScheduleListEmbed(title, targetDate, classes) {
  const targetClasses = classes
    .filter((classInfo) => {
      return (
        normalizeDateText(classInfo.date) === normalizeDateText(targetDate) &&
        String(classInfo.subject || '').trim() !== ''
      );
    })

  let description = '';

  if (targetClasses.length === 0) {
    description = '授業予定はないわん。';
  } else {
    description = targetClasses
      .map((classInfo, index) => {
        const start = classInfo.start || '開始未入力';
        const end = classInfo.end || '終了未入力';
        const subject = classInfo.subject || '科目未入力';
        const room = classInfo.room || '教室未入力';
        const teacher = classInfo.teacher || '先生未入力';

        return [
          `**${index + 1}. ${subject}**`,
          `時間：${start} - ${end}`,
          `教室：${room}`,
          `先生：${teacher}`,
        ].join('\n');
      })
      .join('\n\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x22c55e)
    .addFields({
      name: '日付',
      value: targetDate,
      inline: true,
    })
    .setFooter({
      text: lastLoadedAt
        ? `最終読み込み: ${lastLoadedAt.format('YYYY-MM-DD HH:mm:ss')}`
        : '最終読み込み: 未読み込み',
    });

  return embed;
}

async function sendDailySummary() {
  const now = dayjs().tz(TZ);
  const today = now.format('YYYY-MM-DD');

  if (isInQuietHours(now)) {
    console.log(`夜間時間帯のため、今日の授業一覧送信をスキップしました: ${now.format('HH:mm')}`);
    return;
  }

  if (!DEFAULT_CHANNEL_ID) {
    console.log('DEFAULT_CHANNEL_ID が設定されていないため、朝の授業一覧を送信できません');
    return;
  }

  const sent = loadSent();
  const dailyKey = `daily_summary_${today}_${DEFAULT_CHANNEL_ID}`;

  if (sent[dailyKey]) {
    console.log(`今日の授業一覧は既に送信済みです: ${today}`);
    return;
  }

  try {
    const classes = await reloadClasses();

    if (isDailySummaryOnlyClassDays() && !hasClassesOnDate(classes, today)) {
      console.log(`授業がない日のため、今日の授業一覧送信をスキップしました: ${today}`);
      return;
    }

    const embed = createScheduleListEmbed(
      '今日の授業予定',
      today,
      classes
    );

    const channelResult = await getNotificationChannel(DEFAULT_CHANNEL_ID);

    if (!channelResult.ok) {
      console.log(`今日の授業一覧の通知をスキップしました: ${channelResult.reason}`);
      return;
    }

    const channel = channelResult.channel;

    await channel.send({
      content: 'おはようなのわん！本日の授業予定わん！',
      embeds: [embed],
      allowedMentions: {
        parse: [],
      },
    });

    sent[dailyKey] = {
      sentAt: dayjs().tz(TZ).format(),
      date: today,
      channelId: DEFAULT_CHANNEL_ID,
    };

    saveSent(sent);

    console.log(`今日の授業一覧を送信しました: ${today}`);
  } catch (error) {
    console.error('今日の授業一覧の送信に失敗しました');
    console.error(getErrorMessage(error));
  }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('test')
      .setDescription('授業通知のテストを送るわん')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('today')
      .setDescription('今日の授業一覧を見せるわん')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('tomorrow')
      .setDescription('明日の授業一覧を見せるわん')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('reload')
      .setDescription('スプレッドシートを読み直すわん')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Botからメッセージを送るわん')
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription('送信するメッセージだわん')
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('train')
      .setDescription('山手線の運行情報を確認するわん')
      .toJSON(),
  ];

  // 重要：過去に登録したグローバルコマンドを削除する
  await client.application.commands.set([]);
  console.log('グローバルスラッシュコマンドを削除したわん');

  if (process.env.GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.commands.set(commands);
    console.log(`サーバー専用スラッシュコマンドを登録したわん: ${process.env.GUILD_ID}`);
  } else {
    console.log('GUILD_ID が設定されていないわん。サーバー専用コマンドを登録できないわん…');
  }

  console.log('登録コマンドだわん: test, today, tomorrow, reload, send, train');
}

async function checkSchedule() {
  if (isCheckingSchedule) {
    console.log('前回の授業予定チェックがまだ実行中のため、今回はスキップするわん');
    return;
  }

  isCheckingSchedule = true;

  try {
    console.log('授業開始前通知をチェック中だわん...');

    const now = dayjs().tz(TZ).second(0).millisecond(0);
    const classes = await reloadClasses();

    for (const classInfo of classes) {
      if (!classInfo.date || !classInfo.start || !classInfo.subject) {
        continue;
      }

      if (!classInfo.channelId) {
        console.log(`通知先チャンネルIDがありません: ${classInfo.subject}`);
        continue;
      }

      const startAt = dayjs.tz(
        `${normalizeDateText(classInfo.date)} ${normalizeTimeText(classInfo.start)}`,
        'YYYY-MM-DD HH:mm',
        TZ
      );

      if (!startAt.isValid()) {
        console.log(`日付または時刻の形式が不正です: ${classInfo.subject}`);
        continue;
      }

      const notifyBefore = getNotifyBeforeMinutes();
      const notifyAt = startAt.subtract(notifyBefore, 'minute');

      // 重要：
      // 「30分前を過ぎたら」ではなく、
      // 「授業開始30分前のその1分間だけ」通知する
      if (!isSameMinute(now, notifyAt)) {
        continue;
      }

      const key = createClassKey({
        ...classInfo,
        date: normalizeDateText(classInfo.date),
        start: normalizeTimeText(classInfo.start),
      });

      // 送信直前に sent.json を読み直して二重送信を防ぐ
      const latestSent = loadSent();

      if (latestSent[key]) {
        console.log(`すでに通知済みなのでスキップするわん: ${classInfo.subject}`);
        continue;
      }

      latestSent[key] = {
        status: 'sending',
        notifiedAt: now.format(),
        subject: classInfo.subject,
        date: classInfo.date,
        start: classInfo.start,
        channelId: classInfo.channelId,
      };

      saveSent(latestSent);

      try {
        const result = await notifyClass(classInfo);

        const updatedSent = loadSent();

        if (result.ok) {
          updatedSent[key] = {
            status: 'sent',
            notifiedAt: dayjs().tz(TZ).format(),
            subject: classInfo.subject,
            date: classInfo.date,
            start: classInfo.start,
            channelId: classInfo.channelId,
          };
        } else {
          updatedSent[key] = {
            status: 'skipped',
            skippedAt: dayjs().tz(TZ).format(),
            reason: result.reason,
            subject: classInfo.subject,
            date: classInfo.date,
            start: classInfo.start,
            channelId: classInfo.channelId,
          };
        }

        saveSent(updatedSent);
      } catch (error) {
        console.error(`通知に失敗しました: ${classInfo.subject}`);
        console.error(error);

        const failedSent = loadSent();

        delete failedSent[key];

        saveSent(failedSent);
      }
    }
  } catch (error) {
    console.error('授業予定チェック中にエラーが発生しました');
    console.error(error);
  } finally {
    isCheckingSchedule = false;
  }
}

client.once('clientReady', async () => {
  console.log(`ログインしました: ${client.user.tag}`);
  console.log(`通知時間: ${getNotifyBeforeMinutes()}分前`);
  console.log(`朝の授業一覧送信時刻: ${getDailySummaryTime()}`);

  console.log(`夜間通知制限: ${isQuietHoursEnabled() ? '有効' : '無効'}`);
  console.log(`夜間通知停止時間: ${getQuietHoursStart()}〜${getQuietHoursEnd()}`);
  console.log(`山手線通知は授業日のみ: ${isTrainNotifyOnlyClassDays() ? 'はい' : 'いいえ'}`);
  console.log(`朝の授業予定通知は授業日のみ: ${isDailySummaryOnlyClassDays() ? 'はい' : 'いいえ'}`);

  await registerCommands().catch(console.error);

  // checkSchedule().catch(console.error);

  // 毎分、授業開始前通知をチェック
  cron.schedule('* * * * *', () => {
    checkSchedule().catch(console.error);
  }, {
    timezone: TZ,
  });

  // 毎朝の授業一覧送信
  const dailyTime = getDailySummaryTime();
  const [dailyHour, dailyMinute] = dailyTime.split(':');

  const dailyCron = `${Number(dailyMinute)} ${Number(dailyHour)} * * *`;

  console.log(`毎朝の授業一覧送信スケジュール: ${dailyTime}`);
  console.log(`cron: ${dailyCron}`);

  cron.schedule(dailyCron, () => {
    sendDailySummary().catch(console.error);
  }, {
    timezone: TZ,
  });

  if (isTrainInfoEnabled()) {
    const trainInterval = getTrainCheckIntervalMinutes();

    console.log(`山手線運行情報チェック: ${trainInterval}分ごとだわん`);

    // 起動時に一度チェックするわん
    checkTrainInfo().catch(console.error);

    // 定期チェックするわん
    cron.schedule(`*/${trainInterval} * * * *`, () => {
      checkTrainInfo().catch(console.error);
    }, {
      timezone: TZ,
    });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'test') {
    try {
      await interaction.deferReply({
        ephemeral: true,
      });

      await notifyClass(
        {
          date: dayjs().tz(TZ).format('YYYY-MM-DD'),
          start: dayjs().tz(TZ).add(30, 'minute').format('HH:mm'),
          end: dayjs().tz(TZ).add(90, 'minute').format('HH:mm'),
          subject: 'テスト授業',
          room: 'テスト教室',
          teacher: 'テスト先生',
          channelId: interaction.channelId,
        },
        {
          mentionEveryone: false,
        }
      );

      await interaction.editReply('テスト通知を送信しました。');
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('テスト通知の送信に失敗しました。');
      } else {
        await interaction.reply({
          content: 'テスト通知の送信に失敗しました。',
          ephemeral: true,
        });
      }
    }

    return;
  }

  if (interaction.commandName === 'today') {
    try {
      await interaction.deferReply();

      const classes = await reloadClasses();
      const today = dayjs().tz(TZ).format('YYYY-MM-DD');

      const embed = createScheduleListEmbed(
        '今日の授業一覧',
        today,
        classes
      );

      async function sendDailySummary() {
        const today = dayjs().tz(TZ).format('YYYY-MM-DD');
        const sent = loadSent();

        const dailyKey = `daily_summary_${today}_${DEFAULT_CHANNEL_ID}`;

        if (sent[dailyKey]) {
          console.log(`今日の授業一覧は既に送信済みです: ${today}`);
          return;
        }

        if (!DEFAULT_CHANNEL_ID) {
          console.log('DEFAULT_CHANNEL_ID が設定されていないため、朝の授業一覧を送信できません');
          return;
        }

        try {
          const classes = await reloadClasses();

          const embed = createScheduleListEmbed(
            '今日の授業予定だわん。',
            today,
            classes
          );

          const channel = await client.channels.fetch(DEFAULT_CHANNEL_ID);

          if (!channel) {
            console.log(`チャンネルが見つかりません: ${DEFAULT_CHANNEL_ID}`);
            return;
          }

          await channel.send({
            content: 'みんなおはよぉ！本日の授業予定だわん！',
            embeds: [embed],
            allowedMentions: {
              parse: [],
            },
          });

          sent[dailyKey] = {
            sentAt: dayjs().tz(TZ).format(),
            date: today,
            channelId: DEFAULT_CHANNEL_ID,
          };

          saveSent(sent);

          console.log(`今日の授業一覧を送信しました: ${today}`);
        } catch (error) {
          console.error('今日の授業一覧の送信に失敗しました');
          console.error(getErrorMessage(error));
        }
      }

      await interaction.editReply({
        embeds: [embed],
      });
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          `今日の授業一覧の取得に失敗しました。\n原因: ${getErrorMessage(error)}`
        );
      } else {
        await interaction.reply({
          content: '今日の授業一覧の取得に失敗しました。',
          ephemeral: true,
        });
      }
    }

    return;
  }

  if (interaction.commandName === 'tomorrow') {
    try {
      await interaction.deferReply();

      const classes = await reloadClasses();
      const tomorrow = dayjs().tz(TZ).add(1, 'day').format('YYYY-MM-DD');

      const embed = createScheduleListEmbed(
        '明日の授業一覧',
        tomorrow,
        classes
      );

      await interaction.editReply({
        embeds: [embed],
      });
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('明日の授業一覧の取得に失敗しました。');
      } else {
        await interaction.reply({
          content: '明日の授業一覧の取得に失敗しました。',
          ephemeral: true,
        });
      }
    }

    return;
  }

  if (interaction.commandName === 'reload') {
    try {
      await interaction.deferReply({
        ephemeral: true,
      });

      const classes = await reloadClasses();
      const resetTrainCount = resetTrainInfoState();

      await interaction.editReply(
        `スプレッドシートを再読み込みしたわん...\n` +
        `読み込み件数: ${classes.length}件\n` +
        `最終読み込み: ${lastLoadedAt.format('YYYY-MM-DD HH:mm:ss')}\n` +
        `山手線通知状態もリセットしたわん: ${resetTrainCount}件`
      );
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          `スプレッドシートの再読み込みに失敗したわん...\n原因: ${getErrorMessage(error)}`
        );
      } else {
        await interaction.reply({
          content: 'スプレッドシートの再読み込みに失敗したわん...',
          ephemeral: true,
        });
      }
    }

    return;
  }
  if (interaction.commandName === 'send') {
    try {
      await interaction.deferReply({
        ephemeral: true,
      });

      const hasPermission =
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

      if (!hasPermission) {
        await interaction.editReply('このコマンドを使う権限がないわん...');
        return;
      }

      const message = interaction.options.getString('message', true);

      await interaction.channel.send({
        content: message,
        allowedMentions: {
          parse: [],
        },
      });

      await interaction.editReply('メッセージを送信したわん！');
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          `メッセージ送信に失敗したわん...\n原因: ${getErrorMessage(error)}`
        );
      } else {
        await interaction.reply({
          content: `メッセージ送信に失敗したわん...\n原因: ${getErrorMessage(error)}`,
          ephemeral: true,
        });
      }
    }

    return;
  }
  if (interaction.commandName === 'train') {
    try {
      await interaction.deferReply();

      const trainInfo = await fetchTrainInfo();
      const embed = createTrainInfoEmbed(trainInfo);

      await interaction.editReply({
        content: `${trainInfo.lineName} の現在の運行情報わん！。`,
        embeds: [embed],
      });
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          `山手線の運行情報取得に失敗しました。\n原因: ${getErrorMessage(error)}`
        );
      } else {
        await interaction.reply({
          content: `山手線の運行情報取得に失敗しました。\n原因: ${getErrorMessage(error)}`,
          ephemeral: true,
        });
      }
    }

    return;
  }
});

client.login(DISCORD_TOKEN);
