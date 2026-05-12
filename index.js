require('dotenv').config();

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { google } = require('googleapis');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
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
const NOTIFY_BEFORE = Number(NOTIFY_MINUTES_BEFORE || 30);

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

function loadSent() {
  if (!fs.existsSync(SENT_FILE)) {
    fs.writeFileSync(SENT_FILE, JSON.stringify({}, null, 2));
  }

  return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'));
}

function saveSent(sent) {
  fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2));
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
    throw new Error('SPREADSHEET_ID が設定されていません。Renderまたは.envを確認してください。');
  }

  const credentialsPath = getGoogleCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Google認証ファイルが見つかりません: ${credentialsPath}\n` +
      `ローカルの場合は credentials.json をプロジェクト直下に置いてください。\n` +
      `Renderの場合は Secret File に credentials.json を追加し、GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/credentials.json を設定してください。`
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

    console.log('Google Sheets 読み込み開始');
    console.log(`SPREADSHEET_ID: ${SPREADSHEET_ID}`);
    console.log(`SHEET_RANGE: ${range}`);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    const rows = res.data.values || [];

    console.log(`Google Sheets 読み込み成功: ${rows.length}行`);

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
          date: date || '',
          start: start || '',
          end: end || '',
          subject: subject || '',
          room: room || '',
          teacher: teacher || '',
          channelId: channelId || DEFAULT_CHANNEL_ID || '',
        };
      });
  } catch (error) {
    console.error('Google Sheets の取得に失敗しました');
    console.error(getErrorMessage(error));
    throw error;
  }
}

async function reloadClasses() {
  try {
    classCache = await fetchClasses();
    lastLoadedAt = dayjs().tz(TZ);

    console.log(`スプレッドシートを再読み込みしました: ${classCache.length}件`);

    return classCache;
  } catch (error) {
    console.error('reloadClasses でエラーが発生しました');
    console.error(getErrorMessage(error));
    throw error;
  }
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

async function notifyClass(classInfo, options = {}) {
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

  // const mention = options.mentionEveryone === false ? '' : '@everyone ';

  await channel.send({
    content: `${mention}${NOTIFY_BEFORE}分後に授業があります。`,
    embeds: [embed],
  });

  console.log(`通知しました: ${classInfo.subject}`);
}

function createScheduleListEmbed(title, targetDate, classes) {
  const targetClasses = classes
    .filter((classInfo) => classInfo.date === targetDate)
    .sort((a, b) => {
      const timeA = a.start || '';
      const timeB = b.start || '';
      return timeA.localeCompare(timeB);
    });

  let description = '';

  if (targetClasses.length === 0) {
    description = '授業予定はありません。';
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

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('test')
      .setDescription('授業通知のテストを送信します')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('today')
      .setDescription('今日の授業一覧を表示します')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('tomorrow')
      .setDescription('明日の授業一覧を表示します')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('reload')
      .setDescription('スプレッドシートを再読み込みします')
      .toJSON(),
  ];

  if (process.env.GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await guild.commands.set(commands);
    console.log('サーバー専用スラッシュコマンドを登録しました');
  } else {
    await client.application.commands.set(commands);
    console.log('グローバルスラッシュコマンドを登録しました');
  }
}

async function checkSchedule() {
  if (isCheckingSchedule) {
    console.log('前回の授業予定チェックがまだ実行中のため、今回はスキップします');
    return;
  }

  isCheckingSchedule = true;

  try {
    console.log('授業予定をチェック中...');

    const now = dayjs().tz(TZ);
    const sent = loadSent();

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
        // 先に通知済みとして保存して、処理重複による二重送信を防ぐ
        sent[key] = {
          status: 'sending',
          notifiedAt: now.format(),
          subject: classInfo.subject,
          date: classInfo.date,
          start: classInfo.start,
          channelId: classInfo.channelId,
        };
        saveSent(sent);

        try {
          await notifyClass(classInfo);

          sent[key] = {
            status: 'sent',
            notifiedAt: dayjs().tz(TZ).format(),
            subject: classInfo.subject,
            date: classInfo.date,
            start: classInfo.start,
            channelId: classInfo.channelId,
          };
          saveSent(sent);
        } catch (error) {
          console.error(`通知に失敗しました: ${classInfo.subject}`);
          console.error(error);

          // 送信失敗時は次回再送できるように通知済み記録を消す
          delete sent[key];
          saveSent(sent);
        }
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

  await registerCommands().catch(console.error);

  checkSchedule().catch(console.error);

  cron.schedule('* * * * *', () => {
    checkSchedule().catch(console.error);
  }, {
    timezone: TZ,
  });
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

      await interaction.editReply(
        `スプレッドシートを再読み込みしました。\n読み込み件数: ${classes.length}件\n最終読み込み: ${lastLoadedAt.format('YYYY-MM-DD HH:mm:ss')}`
      );
    } catch (error) {
      console.error(error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          `スプレッドシートの再読み込みに失敗しました。\n原因: ${getErrorMessage(error)}`
        );
      } else {
        await interaction.reply({
          content: 'スプレッドシートの再読み込みに失敗しました。',
          ephemeral: true,
        });
      }
    }

    return;
  }
});

client.login(DISCORD_TOKEN);
