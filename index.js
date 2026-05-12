require('dotenv').config();

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { google } = require('googleapis');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

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
const NOTIFY_BEFORE = Number(NOTIFY_MINUTES_BEFORE || 30);

const SENT_FILE = process.env.SENT_FILE || path.join(__dirname, 'sent.json');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function loadSent() {
  if (!fs.existsSync(SENT_FILE)) {
    fs.writeFileSync(SENT_FILE, JSON.stringify({}, null, 2));
  }

  return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'));
}

function saveSent(sent) {
  fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2));
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({
    version: 'v4',
    auth,
  });
}

async function fetchClasses() {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE || '授業!A2:G',
  });

  const rows = res.data.values || [];

  return rows.map((row) => {
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
      date,
      start,
      end,
      subject,
      room,
      teacher,
      channelId: channelId || DEFAULT_CHANNEL_ID,
    };
  });
}

function createClassKey(classInfo) {
  return `${classInfo.date}_${classInfo.start}_${classInfo.subject}_${classInfo.channelId}`;
}

async function notifyClass(classInfo) {
  const channel = await client.channels.fetch(classInfo.channelId);

  if (!channel) {
    console.log(`チャンネルが見つかりません: ${classInfo.channelId}`);
    return;
  }

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
        value: `${classInfo.start} - ${classInfo.end || '未入力'}`,
        inline: true,
      },
      {
        name: '教室',
        value: classInfo.room || '未入力',
        inline: true,
      },
      {
        name: '先生',
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
      text: `${NOTIFY_BEFORE}分前通知`,
    });

  await channel.send({
    content: `@everyone ${NOTIFY_BEFORE}分後に授業があります。`,
    embeds: [embed],
  });

  console.log(`通知しました: ${classInfo.subject}`);
}

async function checkSchedule() {
  console.log('授業予定をチェック中...');

  const now = dayjs().tz(TZ);
  const sent = loadSent();

  const classes = await fetchClasses();

  for (const classInfo of classes) {
    if (!classInfo.date || !classInfo.start || !classInfo.subject) {
      continue;
    }

    if (!classInfo.channelId) {
      console.log(`通知先チャンネルIDがありません: ${classInfo.subject}`);
      continue;
    }

    const startAt = dayjs.tz(
      `${classInfo.date} ${classInfo.start}`,
      'YYYY-MM-DD HH:mm',
      TZ
    );

    if (!startAt.isValid()) {
      console.log(`日付または時刻の形式が不正です: ${classInfo.subject}`);
      continue;
    }

    const notifyAt = startAt.subtract(NOTIFY_BEFORE, 'minute');

    const key = createClassKey(classInfo);

    const shouldNotify =
      now.isAfter(notifyAt) &&
      now.isBefore(startAt) &&
      !sent[key];

    if (shouldNotify) {
      await notifyClass(classInfo);
      sent[key] = {
        notifiedAt: now.format(),
      };
      saveSent(sent);
    }
  }
}

client.once('clientReady', () => {
  console.log(`ログインしました: ${client.user.tag}`);

  // 起動時に一度チェック
  checkSchedule().catch(console.error);

  // 毎分チェック
  cron.schedule('* * * * *', () => {
    checkSchedule().catch(console.error);
  }, {
    timezone: TZ,
  });
});

client.login(DISCORD_TOKEN);
