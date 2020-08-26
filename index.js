process.env.NODE_ENV === "production" ? "" : require("dotenv").config();
const server = require("express")();
const fs = require("fs");
const Queue = require("bull");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const bot = new TelegramBot(process.env.TOKEN, {
  polling: true,
});

function getFile(url, id) {
  return new Promise((resolve, reject) => {
    axios({ url, responseType: "stream" }).then((response) => {
      response.data
        .pipe(fs.createWriteStream(`./shared/${id}.jpg`))
        .on("finish", () => resolve(response.data))
        .on("error", () => reject("an error occured"));
    });
  });
}

bot.onText(/\/echo (.+)/, (msg, match) => {
  // 'msg' is the received Message from Telegram
  // 'match' is the result of executing the regexp above on the text content
  // of the message

  const chatId = msg.chat.id;
  const resp = match[1]; // the captured "whatever"

  // send back the matched "whatever" to the chat
  bot.sendMessage(chatId, resp);
});

bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;

    if (msg.text.toLowerCase() === "/start") {
        return bot.sendMessage(chatId, `
Welcome to Quick Uploader Bot!

I'm Quick Uploader bot, responsible for uploading files to your google drive storage, you can send a direct download URL and I'll upload it into your google drive storage and send you it's drive link.

To start the bot, I need to authenticate your account.

Use /auth command to authenticate your account!
`)
    } else if (msg.text.toLowerCase() === "/auth") {
        bot.sendMessage(chatId, `To authorise your Google Account open 👇🏻 link, allow permissions to bot and send verification code to bot.`) 
    }
    // let file;
    // if (msg.photo) {
    //   const fileId = msg.photo[msg.photo.length - 1].file_id;
    //   const fileStream = await bot.getFileStream(fileId);
    //   await bot.sendPhoto(chatId, fileStream);
    // } else if (msg.document) {
    //   file = await bot.getFile(msg.document.file_id);
    //   bot.sendDocument(chatId, file);
    // }

    bot.sendMessage(chatId, "File received");
  } catch (e) {
    console.log(e.message);
  }
});
