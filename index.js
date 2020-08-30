process.env.NODE_ENV === "production" ? "" : require("dotenv").config();
require("./src/db/mongoose");
const server = require("express")();
const fs = require("fs");
const Queue = require("bull");
const filesize = require("filesize");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const mime = require('mime-types');
const isUrl = require("is-url");
const User = require("./src/models/user");
const request = require("request");
const progress = require("request-progress");
const path = require("path");
const dir = "./shared";
const { OAuth2Client } = require('google-auth-library');
const { chat } = require("googleapis/build/src/apis/chat");
const PORT = process.env.PORT || 3000

fs.mkdirSync(dir, { recursive: true });

const bot = new TelegramBot(
  process.env.TOKEN,
  {
    polling: true,
  }
);
const users = {}

let REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const uploadFileQueue = new Queue('uploadFile', REDIS_URL);

function uploadFile(auth, filename, folderId, { job, done }) {
  return new Promise((resolve, reject) => {
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = {
      'name': filename,
      parents: [job.data.current_folder_id]
    };
    let isTrigerred = false;
    const media = {
      mimeType: "application/octet-stream",
      resumable: true,
      body: fs.createReadStream('./shared/' + filename)
    };
    const req = drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id'
    }, {
      onUploadProgress(e) {
          if (!isTrigerred) {
            isTrigerred = true;
            setTimeout(() => {
              isTrigerred = false;
            }, 2000)
            bot.editMessageText(`
Uploading your file...
                
Upload Progress: ${((e.bytesRead.toString()/job.data.filesize) * 100).toFixed(2)}% 
                      
Uploaded: ${filesize(e.bytesRead.toString())} of ${filesize(job.data.filesize)}
                `, {
              message_id: job.data.message_id,
              chat_id: job.data.chatId,
              reply_markup: JSON.stringify({
                remove_inline_keyboard: true
              })
            })
          }
      } 
    },(err, file) => {
      if (err) {
        done(new Error("Upload failed!"))
      } else {
        fs.readdir(dir, (err, files) => {
          if (err) throw err;
          for (const file of files) {
            fs.unlink(path.join(dir, file), (err) => {
              if (err) throw err;
            });
          }
        });
        
        done(null, {
          message: `
**Upload completed!**

You can check your uploaded file in /myfiles

Thank you for using @QuickUploaderBot 
`,
          message_id: job.data.message_id,
          chat_id: job.data.chatId
        })
      }
    });
  })
}

function renameFolderOrFile(auth, folder_or_file, chat_id) {
  const drive = google.drive({ version: 'v3', auth });
  drive.files.update({
    auth,
    fileId: folder_or_file.id,
    resource: {
      name: folder_or_file.name
    }
  }, (err, file) => {
    if (err) return bot.sendMessage(chat_id, "Something went wrong!");
    bot.sendMessage(chat_id, "Renamed Successfully!", {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "🔙 Back to Main Directory", callback_data: "root folder" }], [{ text: "❌ Close", callback_data: " cancel" }]]
      }),
    })
  })
}

function deleteFolderOrFile(auth, folder_or_file_id, chat_id, message_id) {
  const drive = google.drive({ version: 'v3', auth });
  drive.files.delete({
    auth,
    fileId: folder_or_file_id,
    fields: 'id'
  }, (err, file) => {
    if (err) return bot.sendMessage(chat_id, "Something went wrong!");
    bot.editMessageText("Deleted Successfully!", {
      message_id,
      chat_id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "🔙 Back to Main Directory", callback_data: "root folder" }], [{ text: "❌ Close", callback_data: " cancel" }]]
      }),
    })
  })
}

function insertFolder(auth, folder, chat_id, message_id) {
  const drive = google.drive({ version: 'v3', auth });
  drive.files.create({
    resource: {
      parents: [folder.id],
      mimeType: 'application/vnd.google-apps.folder',
      name: folder.name
    },
    auth
  }, (err, file) => {
    if (err) return bot.sendMessage(chat_id, "Something went wrong!");
    bot.sendMessage(chat_id, "Folder Created!", {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: `Go to '${folder.name}' folder`, callback_data: `${file.data.id} folder` }], [{ text: "🔙 Back to Main Directory", callback_data: "root folder" }], [{ text: "❌ Close", callback_data: " cancel" }]]
      }),
    })
  })
}

const MAXIMUM_CONCURRENCY_WORKER = 1
let current_job_id;
uploadFileQueue.process(MAXIMUM_CONCURRENCY_WORKER, async (job, done) => {
  current_job_id = job.id; 

  const oAuth2Client = new OAuth2Client(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

  oAuth2Client.setCredentials(job.data.credentials);
  const writer = fs.createWriteStream("./shared/" + job.data.filename);
  progress(request(job.data.url))
    .on("progress", function (state) {
        job.progress({
          message: `
Download Progress: ${(state.percent * 100).toFixed(2)}% 
          
Downloaded: ${filesize(state.size.transferred)} of ${filesize(state.size.total)}
          
Download Speed: ${filesize(state.speed)}/s
          
ETA: ${state.time.remaining}s`,
          message_id: job.data.message_id,
          chat_id: job.data.chatId
        })
    })
    .on("error", function (err) {
        console.log(err, "Something went wrong!")
        // Delete all file in shared folder
        fs.readdir(dir, (err, files) => {
          if (err) throw err;
          for (const file of files) {
            fs.unlink(path.join(dir, file), (err) => {
              if (err) throw err;
            });
          }
        });
        done(new Error(err))
    })
    .on("end", () => {
      job.progress({
        message: `
**Download completed!**

Preparing files to upload...
`,
        message_id: job.data.message_id,
        chat_id: job.data.chatId
      });
      uploadFile(oAuth2Client, job.data.filename, 'root', {
        job,
        done
      });
    })
    .pipe(writer);
});

uploadFileQueue.on("global:progress", (jobId, { message, message_id, chat_id }) => {
  bot.editMessageText(message, {
    message_id,
    chat_id,
    reply_markup: JSON.stringify({
      remove_inline_keyboard: true
    }),
    parse_mode: "Markdown"
  })
});

uploadFileQueue.on("global:completed", (jobId, data) => {
  const { message_id, chat_id, message } = JSON.parse(data)
  bot.editMessageText(message, {
    message_id,
    chat_id,
    reply_markup: JSON.stringify({
      remove_inline_keyboard: true
    }),
    parse_mode: "Markdown"
  })
});

uploadFileQueue.on("global:failed", async (jobId, data) => {
  bot.editMessageText(`Failed to upload files! Please try again in a few seconds`, {
    message_id: data.message_id,
    chat_id: data.chatId,
    reply_markup: JSON.stringify({
      remove_inline_keyboard: true
    }),
    parse_mode: "Markdown"
  })
});

function checkFolderOrFileExists(auth, folder_or_file_id) {
  return new Promise((resolve, reject) => {
    const drive = google.drive({version: 'v3', auth});
    drive.files.list({
      includeRemoved: false,
      fileId: folder_or_file_id,
      trashed: false,
      q: `'${folder_or_file_id}' in parents and trashed=false`,
      fields: 'nextPageToken, files(*)',
      spaces: 'drive'
    }, (err, res) => {
      if (err) return reject("An error occured!");
      const files = res.data.files;
      if (files.length) {
        return resolve(true);
      } else {
        return resolve(false);
      }
    })
  })
}

function sendListFiles(auth, chat, fileId = 'root', isEdit = false) {
  const drive = google.drive({version: 'v3', auth});
  drive.files.list({
    includeRemoved: false,
    fileId,
    trashed: false,
    q: `'${fileId}' in parents and trashed=false`,
    fields: 'nextPageToken, files(*)',
    spaces: 'drive'
  }, (err, res) => {
    if (err) return console.log('The API returned an error: ' + err);
    const files = res.data.files;
    if (files.length) {
      // console.log('Files:');
      // files.map((file) => {
      //   console.log(`${file.name} (${file.id})`);
      // });
      const reply_markup = JSON.stringify({
        inline_keyboard: fileId !== 'root' ?
        [[{ text: "⚙️ Folder Settings", callback_data: `${fileId} settings` }], ...files.map((file, index) => [{ text: `${file.size ? '📎' : '📁'} `+ file.name + ` ${file.size ? '(' + filesize(file.size) + ')': ''}`, callback_data: `${file.size ? file.id + " file": file.id + " folder"}`  }]), [{ text: "📤 Upload here!", callback_data: `${fileId} upload` }], [{ text: "🔙 Back to Main Directory", callback_data: "root folder" }], [{ text: "❌ Close", callback_data: " cancel" }]]
        : [[{ text: "⚙️ Folder Settings", callback_data: `${fileId} settings` }], ...files.map((file, index) => [{ text: `${file.size ? '📎' : '📁'} `+ file.name + ` ${file.size ? '(' + filesize(file.size) + ')': ''}`, callback_data: `${file.size ? file.id + " file": file.id + " folder"}`}]), [{ text: "📤 Upload here!", callback_data: `${fileId} upload` }], [{ text: "❌ Close", callback_data: " cancel" }]]
      })
      isEdit ?  
      bot.editMessageText("Choose your file/folder to manage!", {
        message_id: chat.message_id,
        chat_id: chat.id,
        reply_markup
      })
      : bot.sendMessage(chat.id, "Choose your file/folder to manage!", {
        reply_markup
      })
    } else {
      console.log('No files found.');
      bot.editMessageText("Choose your file/folder to manage!", {
        message_id: chat.message_id,
        chat_id: chat.id,
        reply_markup: JSON.stringify({
          inline_keyboard: fileId !== 'root' ?
          [[{ text: "⚙️ Folder Settings", callback_data: `${fileId} settings` }], [{ text: "📤 Upload here!", callback_data: `${fileId} upload` }], [{ text: "🔙 Back to Main Directory", callback_data: "root folder" }], [{ text: "❌ Close", callback_data: " cancel" }]]
          : [[{ text: "⚙️ Folder Settings", callback_data: `${fileId} settings` }], [{ text: "📤 Upload here!", callback_data: `${fileId} upload` }], [{ text: "❌ Close", callback_data: " cancel" }]]
        })
      })
    }
  });
}

bot.onText(/\/echo (.+)/, (msg, match) => {
  // 'msg' is the received Message from Telegram
  // 'match' is the result of executing the regexp above on the text content
  // of the message

  const chatId = msg.chat.id;
  const resp = match[1]; // the captured "whatever"

  // send back the matched "whatever" to the chat
  console.log(resp)
  bot.sendMessage(chatId, resp);
});

bot.on("message", async (msg) => {
  try {
    const oAuth2Client = new OAuth2Client(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    const chatId = msg.chat.id;
    const user_id = msg.from.id;
    // console.log(msg)
    const user = await User.findOne({ telegram_user_id: user_id });
    if (user) {
      users[chatId] = {
        ...users[chatId],
        tokens: user.tokens,
        current_folder_id: user.current_folder_id || "root"
      }
    }
    if (msg.text.toLowerCase() === "/start") {
      if (!user) {
        const newUser = new User({ telegram_user_id: user_id, username: msg.from.username })
        await newUser.save();
      }
      users[user_id] = {};
      return bot.sendMessage(
        chatId,
        `
Welcome to Quick Uploader Bot!

I'm Quick Uploader bot, responsible for uploading files to your google drive storage, you can send a direct download URL and I'll upload it into your google drive storage and send you it's drive link.

To start the bot, I need to authenticate your account.

Use /auth command to authenticate your account!
`
      );
    }
     else if (users[user_id] && users[user_id].onAuth) {
      oAuth2Client.getToken(msg.text, async (err, token) => {
        if (err) {
          bot.sendMessage(chatId, "Invalid token, please try again! To cancel this action please click the cancel button!");
        } else {
          oAuth2Client.setCredentials(token);
          // Store the token to disk for later program executions
          await User.findOneAndUpdate({ telegram_user_id: user_id }, { $push: { "tokens": token } });
          bot.sendMessage(chatId, "Authorized successfully");
          users[user_id] = {
            ...users[user_id],
            onAuth: false
          }
        }
      });
    } else if (users[user_id] && users[user_id].onUpdateFile) {
      oAuth2Client.setCredentials(user.tokens[0]);
      bot.deleteMessage(chatId, users[user_id].last_message_id);
      renameFolderOrFile(oAuth2Client, { id: users[user_id].choosen_parent_folder, name: msg.text }, chatId, users[user_id].last_message_id);
      delete users[user_id].onUpdateFile;
      delete users[user_id].last_message_id;
      delete users[user_id].choosen_parent_folder;
    } else if (users[user_id] && users[user_id].onCreateFile) {
      oAuth2Client.setCredentials(user.tokens[0]);
      bot.deleteMessage(chatId, users[user_id].last_message_id);
      insertFolder(oAuth2Client, { name: msg.text, id: users[user_id].choosen_parent_folder }, chatId);
      delete users[user_id].onCreateFile;
      delete users[user_id].choosen_parent_folder;
      delete users[user_id].last_message_id;
    } else if (msg.text.includes("/upload")) {
      if (!user.tokens.length) {
        return bot.sendMessage(chatId, "It seems you haven't authenticate your google account, please type /auth to do that")
      }
      const url = msg.text.split(" ").join("").replace("/upload", "");
      if (!isUrl(url)) {
        return bot.sendMessage(chatId, "Invalid url, please try again!")
      }
      request({ url, method: "HEAD" }, async (err, response, body) => {
        const fileSize = response.headers["content-length"];
        const extension = mime.extension(response.headers["content-type"]);
        if (err) return bot.sendMessage(chatId, "URL might be broken! Please try again later.")
        const limit = 107374182400;
        if (fileSize <= limit) {
          const filename = url.split('/').pop().split('#')[0].split('?')[0].replace("." + extension, "") + `.${extension}`;
          await bot.sendMessage(chatId, `
Well done! Your file is ready!

File Name: ${filename}
File Size: ${filesize(fileSize)}
`, {
            reply_markup: JSON.stringify({
              inline_keyboard: [
                [
                  {
                    text: "Upload now!",
                    callback_data: " start"
                  },
                  {
                    text: "Cancel",
                    callback_data: " cancel", // Split data between space with format "<data> <action>"
                  },
                ],
              ],
            }),
          }).then((data) => {
            users[user_id] = {
              ...users[user_id],
              upload_info: {
                url,
                filename,
                filesize: fileSize
              }
            }
          })
        } else 
          bot.sendMessage(chatId, "Failed to upload, the file you wanted to upload was too big! Please choose file with size lesser than 100GB");
      });
    }
    else if (msg.text.toLowerCase() === "/auth") {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
      });
      var options = {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              {
                text: "Authorize",
                url: authUrl,
              },
              {
                text: "Cancel",
                callback_data: " cancel", // Split data between space with format "<data> <action>"
              },
            ],
          ],
        }),
      };
      bot.sendMessage(
        chatId,
        `
To Authorize your google account follow step by step below: 

1. Click 'Authorize' button and visit the link
2. Choose whichever account do you want to use
3. Allow all permissions to this bot
4. Copy the verification bot and send it to me
`,
        options
      );
      users[user_id] = {
        ...users[user_id],
        onAuth: true
      }
    } 
    else if (msg.text.toLowerCase() === "/myfiles") {
      if (!user.tokens.length) {
        return bot.sendMessage(chatId, "It seems you haven't authenticate your google account, please type /auth to do that")
      }
      oAuth2Client.setCredentials(user.tokens[0]);
      sendListFiles(oAuth2Client, { id: user_id });
    } else if (msg.text.toLowerCase() === "/mydrive") {
      bot.sendMessage(chatId, "Choose Your Drive to Manage");
    } else if (msg.text.toLowerCase() === "/myprofile") {
      bot.sendMessage(chatId, 
`<pre>Username      : ${user.username}
Plan          : ${user.plan}
Drive Account : ${user.tokens.length}
Referral      : 0
 </pre>`, { parse_mode: "HTML" });
    } else if (msg.text.toLowerCase() === "/upgrade") {
      bot.sendMessage(chatId, "Coming soon!");
    } else if (msg.text.toLowerCase() === "/revoke") {
      bot.sendMessage(chatId, "Select Google Drive account to be removed");
    } else if (msg.text.toLowerCase() === "/revokeall") { 
      if (!user.tokens.length) return bot.sendMessage(chatId, "Sorry! It seems you don't have any account to revoke") 
      bot.sendMessage(chatId, `
Are you sure ?   

This action will remove all of your google accounts accessibility to our bot
`, {
  reply_markup: JSON.stringify({
    inline_keyboard: [
      [
        {
          text: "Yes",
          callback_data: " revokeall",
        },
        {
          text: "No",
          callback_data: " cancel", 
        },
      ],
    ],
  }),
});
    } else if (msg.text.toLowerCase() === "/about") {
      bot.sendMessage(chatId, `
Hey ${user.username || ""}! Thank you for using this bot

This bot was created by @jokoprasety0. If you liked this bot please share it to anyone who needs it.

This bot is still in beta phase, and still have bugs. There are many things need be changed including the server resource, slow queue, and features!

Thanks again!
`)
    }
    else {
      bot.sendMessage(chatId, `
Unknown command!

Please type '/' to see all available command!

`)
    }
  } catch (e) {
    console.log(e);
  }
});


/* 
  CALLBACK QUERY 
  =====================================================================================================
  =====================================================================================================
*/

bot.on("callback_query", async (query) => {
  const id = query.from.id;
  const message_id = query.message.message_id;
  const chat = { id, message_id }
  const [data, action] = query.data.split(" ");

  const oAuth2Client = new OAuth2Client(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  // console.log(query)

  // Fetch user data if the users object's empty
  if (!users[id]) {
    const user = await User.findOne({ telegram_user_id: id }).lean();
    users[id] = {
      ...users[id],
      tokens: user.tokens,
      current_folder_id: user.current_folder_id || "root"
    }
  }

  if (action === "cancel") {
    users[id] = {
      ...users[id],
      onAuth: false
    }
    bot.deleteMessage(id, message_id)
    users[id].onAuth = false;
    users[id].onCreateFile = false;
  } 
  else if (action === "upload") {
    await User.findOneAndUpdate({ telegram_user_id: id }, { $set: { current_folder_id: data } });
    await bot.sendMessage(id, `
Good! You selected this directory, from now on every files you upload will be uploaded here! 

If you want to change upload directory type /myfiles and click '📤 Upload here!'
`)
await bot.sendMessage(id, `
To upload file please type  /upload <url-file> 

For example:  ` + "`/upload http://speedtest.tele2.net/10GB.zip`" + 
` The Link should be ended with extention file for example .zip, .rar, .apk, .exe and make sure that the file size is not too large with maximum of 100GB`, 

{ parse_mode: "Markdown" })
  } else if (action === "folder") {
    oAuth2Client.setCredentials(users[id].tokens[0])
    sendListFiles(oAuth2Client, chat, data, true);
  } else if (action === "file") {
    bot.editMessageText("What do you want to do with this file ?", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: "✏️ Rename File",
              callback_data: `${data} edit`
            },
            {
              text: "❌ Delete File",
              callback_data: `${data} delete-file`
            }
          ],
          [
            {
              text: "🔙 Back to Main Directory",
              callback_data: `root folder`
            }
          ],
        ],
      }),
      message_id,
      chat_id: id
    })
  } else if (action === "settings") {
    bot.editMessageText("What do you want to do with this folder ?", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: "✏️ Rename Folder",
              callback_data: `${data} edit`
            },
            {
              text: "❌ Delete Folder",
              callback_data: `${data} delete-folder`
            }
          ],
          [
            {
              text: "➕ Create Folder",
              callback_data: `${data} create`
            },
            {
              text: "🔙 Back to Main Directory",
              callback_data: `root folder`
            }
          ],
        ],
      }),
      message_id,
      chat_id: id
    })
  } else if (action === "confirm-delete") {
    oAuth2Client.setCredentials(users[id].tokens[0]);
    deleteFolderOrFile(oAuth2Client, data, id, message_id);
  } else if (action === "delete-file") {
    bot.editMessageText("Are you sure want to delete this file ?", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "Yes", callback_data: `${data} confirm-delete` }, { text: "No", callback_data: `root folder` }], [{ text: "❌ Close", callback_data: " cancel" }]]
      })
    })
  } else if (action === "delete-folder") {
    bot.editMessageText("Are you sure want to delete this folder ?", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "Yes", callback_data: `${data} confirm-delete` }, { text: "No", callback_data: `${data} folder` }], [{ text: "❌ Close", callback_data: " cancel" }]]
      })
    })
  } else if (action === "edit") {
    bot.editMessageText("Input your folder/file name", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "Cancel", callback_data: " cancel" }]]
      })
    })
    users[id].onUpdateFile = true;
    users[id].last_message_id = message_id;
    users[id].choosen_parent_folder = data;
  } else if (action === "create") {
    bot.editMessageText("Input your folder name (default: 'New Folder')", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "Cancel", callback_data: " cancel" }]]
      })
    })
    
    users[id].onCreateFile = true;
    users[id].last_message_id = message_id;
    users[id].choosen_parent_folder = data;
  } else if(action === "start") {
    oAuth2Client.setCredentials(users[id].tokens[0]);
    const file_or_folder_exists = await checkFolderOrFileExists(oAuth2Client, users[id].current_folder_id);
    console.log(file_or_folder_exists);
    if (!file_or_folder_exists) return bot.sendMessage(id, "Folder not found! Please Select an existing Folder to Upload!")
    uploadFileQueue.add({
      message_id,
      chatId: id,
      url: users[id].upload_info.url,
      filename: users[id].upload_info.filename,
      filesize: users[id].upload_info.filesize,
      credentials: users[id].tokens[0],
      current_folder_id: users[id].current_folder_id
    }, { removeOnFail: true, removeOnComplete: true }).then((job) => {
      bot.editMessageText("Your file has been added to the queue, You will be notified when it's your turn!", {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              {
                text: "Check Queue",
                callback_data: `${job.id} check-queue`
              }
            ],
          ],
        }),
        message_id,
        chat_id: id
      })
    })
  } else if (action === "revokeall") {
    await User.findOneAndUpdate({ telegram_user_id: id }, { $set: { tokens: [] } });
    bot.editMessageText(`
Done! ✔️
All your account access has been removed in our system! 

You can always bind your account to our bot by using /auth
`, {
  message_id,
  chat_id: id
})
    users[id].tokens = [];
  } else if (action === "check-queue") {
    let activeJobs = await uploadFileQueue.getActive();
    const waitingJobsCount = await uploadFileQueue.getWaitingCount() 
    activeJobs =  activeJobs.map(job => { 
      return {
        id: job.id,
        processedOn: new Date(job.processedOn)
      } 
    })

    let activeJobInfoStr = "Currently this bot is serving queues number: ";
    activeJobs.forEach((job, index) => {
      if (index === activeJobs.length - 1)
        activeJobInfoStr += `${job.id}`
      else   
        activeJobInfoStr += `${job.id}, `
    })
    bot.answerCallbackQuery({
      callback_query_id: query.id,
      text: 
      `
This file is on queue number ${data}
${activeJobInfoStr}

There're currently ${waitingJobsCount} file(s) are waiting to be uploaded
      `,
      show_alert: true
    })
  }
});

server.listen(PORT, () => console.log("Listening on PORT", PORT));