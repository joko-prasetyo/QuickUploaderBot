process.env.NODE_ENV === "production" ? "" : require("dotenv").config();
require("./src/db/mongoose");
const server = require("express")();
const fs = require("fs");
const Queue = require("bull");
const filesize = require("filesize");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const SCOPES = ["https://www.googleapis.com/auth/drive"];
const mime = require("mime-types");
const isUrl = require("./src/fixtures/is-url");
const User = require("./src/models/user");
const parseTorrent = require("parse-torrent");
const request = require("request");
const progress = require("request-progress");
const got = require("got");
const WebTorrent = require("webtorrent");
const { OAuth2Client } = require("google-auth-library");
const shortUrl = require("node-url-shortener");
const PORT = process.env.PORT || 3000;
const isDirectory = require("is-directory");
const rimraf = require("rimraf");
const mkdirp = require("mkdirp");
const { v4: uuidv4 } = require("uuid");

const dir = "./shared";
const torrent_downloaded_files_dir = "./torrents";

fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(torrent_downloaded_files_dir, { recursive: true });

const bot = new TelegramBot(process.env.TOKEN, {
  polling: true,
});
const users = {};

let REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const uploadFileQueue = new Queue("uploadFile", REDIS_URL);
const uploadTorrentQueue = new Queue("uploadTorrent", REDIS_URL);

async function sleep(ms) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

async function uploadFolderToDriveJob(
  auth,
  drive_folder_id,
  current_path = "./torrent-downloaded-files",
  { job, done }
) {
  return new Promise((resolve, reject) => {
    const drive = google.drive({ version: "v3", auth });
    fs.readdir(current_path, async (err, files) => {
      let index = 0;
      if (!files.length)
        return resolve(
          done
            ? done(null, {
                message: "No file found inside torrent!",
                message_id: job.data.message_id,
                chat_id: job.data.chat_id,
              })
            : "No file found"
        );
      for (const file_name of files) {
        if (isDirectory.sync(`${current_path}/${file_name}`)) {
          const result = await drive.files.create({
            resource: {
              parents: [drive_folder_id],
              mimeType: "application/vnd.google-apps.folder",
              name: file_name,
            },
            auth,
          });
          if (result.data.id) {
            await uploadFolderToDriveJob(
              auth,
              result.data.id,
              `${current_path}/${file_name}`,
              { job }
            );
          }
        } else {
          const file = await uploadFileToDriveJob(
            auth,
            {
              path: `${current_path}/`,
              name: file_name,
            },
            drive_folder_id,
            job
          );
          await sleep(2000);
          console.log("Done Sleep");
        }

        if (index === files.length - 1) {
          resolve(
            done
              ? done(null, {
                  message: `
**Upload completed!**
            
You can check your uploaded file in /myfiles
            
Thank you for using @QuickUploaderBot`,
                  message_id: job.data.message_id,
                  chat_id: job.data.chat_id,
                })
              : "Folder Uploaded"
          );
        }
        index++;
      }
    });
  });
}

function uploadFileToDriveJob(auth, file, drive_folder_id, job) {
  return new Promise((resolve, reject) => {
    const drive = google.drive({ version: "v3", auth });
    const fileMetadata = {
      name: file.name,
      parents: [drive_folder_id],
    };
    let isTrigerred = false;
    const media = {
      mimeType: "application/octet-stream",
      resumable: true,
      body: fs.createReadStream(file.path + file.name),
    };
    const fileSizeInBytes = fs.statSync(file.path + file.name)["size"];
    drive.files.create(
      {
        resource: fileMetadata,
        media,
        fields: "id",
      },
      {
        onUploadProgress(e) {
          try {
            if (!isTrigerred) {
              isTrigerred = true;
              setTimeout(() => {
                isTrigerred = false;
              }, 2000);
              bot.editMessageText(
                `
Uploading ${file.name} to drive...
                
Upload Progress: ${((e.bytesRead.toString() / fileSizeInBytes) * 100).toFixed(
                  2
                )}% 
                      
Uploaded: ${filesize(e.bytesRead.toString())} of ${filesize(fileSizeInBytes)}
                `,
                {
                  message_id: job.data.message_id,
                  chat_id: job.data.chat_id,
                  reply_markup: JSON.stringify({
                    inline_keyboard: [
                      [
                        {
                          text: "Cancel",
                          callback_data: `${job.id} cancel-file-upload`,
                        },
                      ],
                    ],
                  }),
                }
              );
            }
          } catch (e) {
            console.log("Cannot edit message");
          }
        },
      },
      (err, file) => {
        if (err) {
          return resolve(null);
        } else {
          return resolve(file);
        }
      }
    );
  });
}

function renameFolderOrFile(auth, folder_or_file, chat_id) {
  const drive = google.drive({ version: "v3", auth });
  drive.files.update(
    {
      auth,
      fileId: folder_or_file.id,
      resource: {
        name: folder_or_file.name,
      },
    },
    (err, file) => {
      if (err) return bot.sendMessage(chat_id, "Something went wrong!");
      bot.sendMessage(chat_id, "Renamed Successfully!", {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              {
                text: "🔙 Back to Main Directory",
                callback_data: "root folder",
              },
            ],
            [{ text: "❌ Close", callback_data: " cancel" }],
          ],
        }),
      });
    }
  );
}

function deleteFolderOrFile(auth, folder_or_file_id, chat_id, message_id) {
  const drive = google.drive({ version: "v3", auth });
  drive.files.delete(
    {
      auth,
      fileId: folder_or_file_id,
      fields: "id",
    },
    (err, file) => {
      if (err) return bot.sendMessage(chat_id, "Something went wrong!");
      bot.editMessageText("Deleted Successfully!", {
        message_id,
        chat_id,
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              {
                text: "🔙 Back to Main Directory",
                callback_data: "root folder",
              },
            ],
            [{ text: "❌ Close", callback_data: " cancel" }],
          ],
        }),
      });
    }
  );
}

function insertFolder(auth, folder, chat_id, message_id) {
  const drive = google.drive({ version: "v3", auth });
  drive.files.create(
    {
      resource: {
        parents: [folder.id],
        mimeType: "application/vnd.google-apps.folder",
        name: folder.name,
      },
      auth,
    },
    (err, file) => {
      if (err) return bot.sendMessage(chat_id, "Something went wrong!");
      bot.sendMessage(chat_id, "Folder Created!", {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              {
                text: `Go to '${folder.name}' folder`,
                callback_data: `${file.data.id} folder`,
              },
            ],
            [
              {
                text: "🔙 Back to Main Directory",
                callback_data: "root folder",
              },
            ],
            [{ text: "❌ Close", callback_data: " cancel" }],
          ],
        }),
      });
    }
  );
}

const MAXIMUM_CONCURRENCY_WORKER = 5;
uploadTorrentQueue.process(MAXIMUM_CONCURRENCY_WORKER, async (job, done) => {
  console.log("Job is starting");
  const { message_id, chat_id, user_folder_id, credentials, url, identifier } = job.data;
  const oAuth2Client = new OAuth2Client(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  let timeoutSeconds = 0; // Incremental seconds for timeout
  const maximumTimeoutSeconds = 3600; // Maximum idle download timeout of an hour
  // let current_download_speed = 0;
  const tracker_response = await got.get("https://newtrackon.com/api/stable");
  const announce = tracker_response.body.split("\n\n");
  parseTorrent.remote(url, async (err, parsed) => {
    if (err) throw err;
    const magnet_uri = parseTorrent.toMagnetURI(parsed);
    const client = new WebTorrent({
      tracker: true,
    });
    await mkdirp(`${torrent_downloaded_files_dir}/${identifier}`);
    client.add(magnet_uri,{
        announce,
        path: `${torrent_downloaded_files_dir}/${identifier}`,
      },
      (torrent) => {
        const torrent_progress_interval = setInterval(async () => {
          const processing = await job.isActive();
          if (!processing || timeoutSeconds >= maximumTimeoutSeconds) {
            console.log("completing job");
            clearInterval(torrent_progress_interval);
            client.remove(magnet_uri);
            client.destroy();
            return done(null, {
              message:
                "Sorry, Our bot canceled the process, because the torrent stayed on a download speed of 0 kb for 1 hour. Remember that not all torrents are working properly, sometimes the torrent might be very slow to download or broken. To resolve this please choose higher torrent seeders or choose another torrent.",
              message_id,
              chat_id,
            });
          }

          if (torrent.done) {
            bot.editMessageText(
                `
Download completed!
  
Uploading files to your drive...`,
                {
                  chat_id,
                  message_id,
                }
              )
              .catch(() => {
                console.log("Cannot edit message");
              });
            clearInterval(torrent_progress_interval);
            oAuth2Client.setCredentials(credentials);
            await uploadFolderToDriveJob(
              oAuth2Client,
              user_folder_id,
              `${torrent_downloaded_files_dir}/${identifier}`,
              { job, done }
            );
          }

          if (!torrent.downloadSpeed) {
            timeoutSeconds += 2;
          } else {
            timeoutSeconds = 0;
          }

          bot
            .editMessageText(
              `
*Downloading*: ` + "`" + torrent.name + "` (" + filesize(torrent.length) + ")" + `
  
*Download Speed*: ${filesize(torrent.downloadSpeed)}/s
*Downloaded*: ${filesize(torrent.downloaded)}
*Total Downloaded*: ${(torrent.progress * 100).toFixed(2)}%
*Peers*: ${torrent.numPeers}
*Ratio*: ${torrent.ratio.toFixed(3)}
  
*ETA*: ${(torrent.timeRemaining / 1000).toFixed(2)} Seconds`,
              {
                chat_id,
                message_id,
                parse_mode: "Markdown",
                reply_markup: JSON.stringify({
                  inline_keyboard: [
                    [
                      {
                        text: "Cancel",
                        callback_data: `${job.id} cancel-torrent-upload`,
                      },
                    ],
                  ],
                }),
              }
            )
            .catch((e) => {
              console.log("Cannot edit message!");
            });
        }, 2000);
      }
    );
  });
});

uploadFileQueue.process(MAXIMUM_CONCURRENCY_WORKER, async (job, done) => {
  current_job_id = job.id;
  const { chat_id, message_id, filename, credentials, current_folder_id, url } = job.data;
  const oAuth2Client = new OAuth2Client(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  oAuth2Client.setCredentials(credentials);
  await mkdirp(`${dir}/${chat_id}/`);
  const writer = fs.createWriteStream(`${dir}/${chat_id}/${filename}`);
  const req = request(url);
  let requested = true;

  let downloaded_percentage = 0;
  let downloaded_size = 0;
  let total_size = 0;
  let download_speed = 0;
  let eta = 0;
  
  const file_progress_interval = setInterval(async () => {
    const isActive = await job.isActive();
    if (!isActive) {
      clearInterval(file_progress_interval);
      requested = false;
      req.abort();
      return done();
    }
    job.progress({
      message: `
*Download Progress*: ${(downloaded_percentage * 100).toFixed(2)}% 
        
*Downloaded*: ${filesize(downloaded_size)} of ${filesize(total_size)}
        
*Download Speed*: ${filesize(download_speed)}/s
        
*ETA*: ${eta}s`,
      message_id,
      chat_id,
    });
  }, 2000)
  progress(req)
    .on("progress", function (state) { 
      downloaded_percentage = state.percent;
      downloaded_size = state.size.transferred;
      total_size = state.size.total;
      download_speed = state.speed;
      eta = state.time.remaining;
    })
    .on("error", function (err) {
      console.log(err, "Something went wrong!");
      req.abort();
      done(new Error(err));
    })
    .on("end", async () => {
      clearInterval(file_progress_interval);
      if (requested) {
        job.progress({
          message: `
*Download completed!*
  
Preparing files to upload...`,
          message_id,
          chat_id,
        });
        const uploaded_file = await uploadFileToDriveJob(
          oAuth2Client, {
            name: filename,
            path: `${dir}/${chat_id}/`,
          },
          current_folder_id,
          job
        );
        console.log(uploaded_file);
        if (uploaded_file) {
          done(null, {
            message: `
**Upload completed!**
          
You can check your uploaded file in /myfiles
          
Thank you for using @QuickUploaderBot`,
            message_id,
            chat_id,
          });
        } else {
          done(null, {
            message:
              "Insufficient Google Drive Space! You can fix this by deleting some files in your drives.",
            message_id,
            chat_id,
          });
        }
      }
    })
    .pipe(writer);
});

uploadTorrentQueue.on("global:completed", async (jobId, data) => {
  console.log("Upload Torrent Job Completed!");
  const { message_id, chat_id, message, identifier } = JSON.parse(data);
  await bot
    .editMessageText(message, {
      message_id,
      chat_id,
      reply_markup: JSON.stringify({
        remove_inline_keyboard: true,
      }),
      parse_mode: "Markdown",
    })
    .catch(() => {
      console.log("cannot edit message");
    });
  // Delete all file in torrent-downloaded-files folder
  rimraf(`${torrent_downloaded_files_dir}/${identifier}`, function () {
    console.log(`User Directory with ID: ${identifier} has been removed!`);
  });
});

uploadTorrentQueue.on("global:failed", async (jobId, data) => {
  console.log("Upload Torrent Job Completed!");
  const [identifier, message, message_id, chat_id] = data.split("_");
  await bot
    .editMessageText(message, {
      message_id,
      chat_id,
      reply_markup: JSON.stringify({
        remove_inline_keyboard: true,
      }),
      parse_mode: "Markdown",
    })
    .catch(() => {
      console.log("cannot edit message");
    });
  // Delete all file in torrent-downloaded-files folder
  rimraf(`${torrent_downloaded_files_dir}/${identifier}`, function () {
    console.log(`User Directory with ID: ${identifier} has been removed!`);
  });
});

uploadFileQueue.on(
  "global:progress",
  (jobId, { message, message_id, chat_id }) => {
    console.log("Job on progress");
    bot
      .editMessageText(message, {
        message_id,
        chat_id,
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: "Cancel", callback_data: `${jobId} cancel-file-upload` }],
          ],
        }),
        parse_mode: "Markdown",
      })
      .catch((e) => {
        console.log(e.message);
      });
  }
);

uploadFileQueue.on("global:completed", async (jobId, data) => {
  console.log("Job completed");
  const { message_id, chat_id, message } = JSON.parse(data);
  await bot
    .editMessageText(message, {
      message_id,
      chat_id,
      reply_markup: JSON.stringify({
        remove_inline_keyboard: true,
      }),
      parse_mode: "Markdown",
    })
    .catch((e) => {
      console.log(e.message);
    });

  rimraf(dir, () => {
    console.log("Directory Emptied!");
    fs.mkdirSync(dir, { recursive: true });
  });
});

uploadFileQueue.on("global:failed", async (jobId, data) => {
  console.log("Job failed");
  // Delete all file in shared folder
  rmdirAsync(dir, () => {
    console.log("deleted");
    fs.mkdirSync(dir, { recursive: true });
  });
});

function checkFolderOrFileExists(auth, folder_or_file_id) {
  return new Promise((resolve, reject) => {
    const drive = google.drive({ version: "v3", auth });
    drive.files.list(
      {
        includeRemoved: false,
        fileId: folder_or_file_id,
        trashed: false,
        q: `'${folder_or_file_id}' in parents and trashed=false`,
        fields: "nextPageToken, files(*)",
        spaces: "drive",
      },
      (err, res) => {
        if (err) {
          console.log(err);
          return resolve(false);
        }
        return resolve(true);
      }
    );
  });
}

function sendFileLists(auth, chat, fileId = "root", isEdit = false) {
  const drive = google.drive({ version: "v3", auth });
  drive.files.list(
    {
      includeRemoved: false,
      fileId,
      trashed: false,
      q: `'${fileId}' in parents and trashed=false`,
      fields: "nextPageToken, files(*)",
      spaces: "drive",
    },
    (err, res) => {
      if (err) {
        console.log("The API returned an error: " + err);
        return bot.sendMessage(chat.id, `Cannot login to your current account, please relogin your account (/revoke to logout)`);
      }
      // ID Description
      // 44 bytes/characters ID = Google Folder
      // 33 bytes/chracters ID = Google File
      // 72 bytes/characters ID = Google Classroom Folder (Skipped)

      // Skip all file/folder with id length greater than 44
      const files = res.data.files.filter(file => {
        if (file.id.length <= 44) return file
      })

      if (files.length) {
        // callback_data must be 1-64 bytes/characters (Throw an error if exceeded)
        const reply_markup = JSON.stringify({
          inline_keyboard: 
            fileId !== "root"
              ? [
                  [
                    {
                      text: "⚙️ Folder Settings",
                      callback_data: `${fileId} settings`,
                    },
                  ],
                  ...files.map((file, index) => [
                    {
                      text:
                        `${file.size ? "📎" : "📁"} ` +
                        file.name +
                        ` ${file.size ? "(" + filesize(file.size) + ")" : ""}`,
                      callback_data: `${
                        file.size ? file.id + " file" : file.id + " folder"
                      }`,
                    },
                  ]),
                  [
                    {
                      text: "📤 Upload here!",
                      callback_data: `${fileId} upload`,
                    },
                  ],
                  [
                    {
                      text: "🔙 Back to Main Directory",
                      callback_data: "root folder",
                    },
                  ],
                  [{ text: "❌ Close", callback_data: " cancel" }],
                ]
              : [
                  [
                    {
                      text: "⚙️ Folder Settings",
                      callback_data: `${fileId} settings`,
                    },
                  ],
                  ...files.map((file, index) => [
                    {
                      text:
                        `${file.size ? "📎" : "📁"} ` +
                        file.name +
                        ` ${file.size ? "(" + filesize(file.size) + ")" : ""}`,
                      callback_data: `${
                        file.size ? file.id + " file" : file.id + " folder"
                      }`,
                    },
                  ]),
                  [
                    {
                      text: "📤 Upload here!",
                      callback_data: `${fileId} upload`,
                    },
                  ],
                  [{ text: "❌ Close", callback_data: " cancel" }],
                ],
        });
        isEdit
          ? bot.editMessageText("Choose your file/folder to manage!", {
              message_id: chat.message_id,
              chat_id: chat.id,
              reply_markup,
            }).catch(e => console.log(e))
          : bot.sendMessage(chat.id, "Choose your file/folder to manage!", {
              reply_markup,
            }).catch(e => console.log(e));
            // JSON.parse(reply_markup).inline_keyboard.forEach(markup => console.log(markup));
      } else {
        console.log("No files found.");
        fileId === "root"
          ? bot.sendMessage(chat.id, "Choose your file/folder to manage!", {
              reply_markup: JSON.stringify({
                inline_keyboard: [
                  [
                    {
                      text: "⚙️ Folder Settings",
                      callback_data: `${fileId} settings`,
                    },
                  ],
                  [
                    {
                      text: "📤 Upload here!",
                      callback_data: `${fileId} upload`,
                    },
                  ],
                  [{ text: "❌ Close", callback_data: " cancel" }],
                ],
              }),
            })
          : bot.editMessageText("Choose your file/folder to manage!", {
              message_id: chat.message_id,
              chat_id: chat.id,
              reply_markup: JSON.stringify({
                inline_keyboard:
                  fileId !== "root"
                    ? [
                        [
                          {
                            text: "⚙️ Folder Settings",
                            callback_data: `${fileId} settings`,
                          },
                        ],
                        [
                          {
                            text: "📤 Upload here!",
                            callback_data: `${fileId} upload`,
                          },
                        ],
                        [
                          {
                            text: "🔙 Back to Main Directory",
                            callback_data: "root folder",
                          },
                        ],
                        [{ text: "❌ Close", callback_data: " cancel" }],
                      ]
                    : [
                        [
                          {
                            text: "⚙️ Folder Settings",
                            callback_data: `${fileId} settings`,
                          },
                        ],
                        [
                          {
                            text: "📤 Upload here!",
                            callback_data: `${fileId} upload`,
                          },
                        ],
                        [{ text: "❌ Close", callback_data: " cancel" }],
                      ],
              }),
            });
      }
    }
  );
}

function showUserStorageQuota(auth) {
  return new Promise(async (resolve, reject) => {
    try {
      const drive = google.drive({ version: "v3", auth });
      const about = await drive.about.get({
        fields: "storageQuota(*)",
      });
      resolve(about.data.storageQuota);
    } catch (e) {
      resolve(null);
    }
  });
}

function showUserInfo(auth) {
  return new Promise(async (resolve, reject) => {
    try {
      const drive = google.drive({ version: "v3", auth });
      const info = await drive.about.get({
        fields: "user(*)",
      });
      resolve(info.data.user);
    } catch (e) {
      resolve(null);
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
  console.log(resp);
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
    const selected_credentials_index = user.selected_credentials_index;
    if (user) {
      users[chatId] = {
        ...users[chatId],
        credentials: user.tokens[user.selected_credentials_index],
        current_folder_id: user.current_folder_id || "root",
      };
    }

    if (msg.document && msg.document.mime_type === "application/x-bittorrent") {
      if (!user.tokens.length) {
        return bot.sendMessage(
          chatId,
          "It seems you haven't authenticate your google account, please type /auth to do that"
        );
      }

      oAuth2Client.setCredentials(user.tokens[selected_credentials_index]);
      const folderExists = await checkFolderOrFileExists(
        oAuth2Client,
        users[chatId].current_folder_id
      );
      if (!folderExists)
        return bot.sendMessage(
          chatId,
          "Folder not found! Please select an existing folder to upload!"
        );
      const url = await bot.getFileLink(msg.document.file_id);
      const quota = await showUserStorageQuota(oAuth2Client);
      if (!quota)
        return bot.sendMessage(
          chatId,
          "Something went wrong! Please try again later."
        );
      request({ url, encoding: null }, (err, resp, buffer) => {
        const torrent = parseTorrent(buffer);
        if (quota.usageInDrive + torrent.length > quota.limit) {
          bot.sendMessage(
            chatId,
            "Insufficient Google Drive Space! You can fix this by deleting some files in your drives."
          );
        } else {
          shortUrl.short(url, (err, url) => {
            if (err) return bot.sendMessage(chatId, "Cannot shorten url");
            bot.sendMessage(
              chatId,
              `
Your torrent file's ready!

File Name: ${torrent.name}
File Size: ${filesize(torrent.length)}`,
              {
                reply_markup: JSON.stringify({
                  inline_keyboard: [
                    [
                      {
                        text: "Upload Now!",
                        callback_data: `${url} start-torrent`,
                      },
                      { text: "Cancel", callback_data: " cancel" },
                    ],
                  ],
                }),
              }
            );
          });
        }
      });
      return;
    }

    if (msg.document || msg.photo || msg.video || msg.voice) {
      return bot.sendMessage(
        chatId,
        "Sorry, this bot is currently not supporting files except torrent"
      );
    }

    if (msg.text.toLowerCase() === "/start") {
      if (!user) {
        const newUser = new User({
          telegram_user_id: user_id,
          username: msg.from.username,
        });
        await newUser.save();
      }
      users[user_id] = {};
      return bot.sendMessage(
        chatId,
        `
Welcome to Quick Uploader Bot!

I'm Quick Uploader Bot, responsible for uploading files to your google drive storage, you can send a direct download URL or torrent file and I'll upload it into your google drive storage.

To start the bot, I need to authenticate your account.

Use /auth command to authenticate your account!
`
      );
    } else if (users[user_id] && users[user_id].onAuth) {
      oAuth2Client.getToken(msg.text, async (err, token) => {
        if (err) {
          bot.sendMessage(
            chatId,
            "Invalid token, please try again! To cancel this action please click the cancel button!"
          );
        } else { 
          oAuth2Client.setCredentials(token);
          const userInfo = await showUserInfo(oAuth2Client);
          const isUserExists = user.tokens.find(token => token.ownership === userInfo.emailAddress);
          if (isUserExists) {
            return bot.sendMessage(chatId, "That email was already logged in! You should try different account");
          }
          // Store the token to disk for later program executions
          user.tokens.push({ ...token, ownership: userInfo.emailAddress });
          user.selected_credentials_index = user.tokens.length - 1;
          await user.save();
          bot.sendMessage(chatId, "Authorized successfully");
          users[user_id] = {
            ...users[user_id],
            onAuth: false,
          };
        }
      });
    } else if (users[user_id] && users[user_id].onUpdateFile) {
      oAuth2Client.setCredentials(user.tokens[selected_credentials_index]);
      bot.deleteMessage(chatId, users[user_id].last_message_id);
      renameFolderOrFile(
        oAuth2Client,
        { id: users[user_id].choosen_parent_folder, name: msg.text },
        chatId,
        users[user_id].last_message_id
      );
      delete users[user_id].onUpdateFile;
      delete users[user_id].last_message_id;
      delete users[user_id].choosen_parent_folder;
    } else if (users[user_id] && users[user_id].onCreateFile) {
      oAuth2Client.setCredentials(user.tokens[selected_credentials_index]);
      bot.deleteMessage(chatId, users[user_id].last_message_id);
      insertFolder(
        oAuth2Client,
        { name: msg.text, id: users[user_id].choosen_parent_folder },
        chatId
      );
      delete users[user_id].onCreateFile;
      delete users[user_id].choosen_parent_folder;
      delete users[user_id].last_message_id;
    } else if (msg.text.includes("/upload")) {
      if (!user.tokens[selected_credentials_index]) {
        return bot.sendMessage(chatId, "No account selected! enter /mydrive for more details");
      }

      oAuth2Client.setCredentials(user.tokens[selected_credentials_index]);
      const folderExists = await checkFolderOrFileExists(
        oAuth2Client,
        users[user_id].current_folder_id
      );

      if (!folderExists)
        return bot.sendMessage(
          chatId,
          "Folder not found in this account. Please select an existing folder to upload or switch between your google drive account"
        );
      if (!user.tokens.length) {
        return bot.sendMessage(
          chatId,
          "It seems you haven't authenticate your google account, please type /auth to do that"
        );
      }
      const url = msg.text.split(" ").join("").replace("/upload", "");
      if (!isUrl(url)) {
        return bot.sendMessage(chatId, "Invalid url, please try again!");
      }
      const res = await got.head(url);
      // console.log(res.headers);
      const filetype = {
        ext: mime.extension(res.headers["content-type"]),
        mime: res.headers["content-type"],
      };
      const fileSize = res.headers["content-length"];
      if (!fileSize) return bot.sendMessage(chatId, "File is not available, please try other url!")
      const limit = 107374182400;
      if (fileSize <= limit) {
        const filename =
          url
            .split("/")
            .pop()
            .split("#")[0]
            .split("?")[0]
            .replace("." + filetype.ext, "") + `.${filetype.ext}`;
        await bot
          .sendMessage(
            chatId,
            `
Well done! Your file is ready!

File Name: ${filename}
File Size: ${filesize(fileSize)}

Note: The name of file can be changed sometimes
`,
            {
              reply_markup: JSON.stringify({
                inline_keyboard: [
                  [
                    {
                      text: "Upload Now!",
                      callback_data: " start",
                    },
                    {
                      text: "Cancel",
                      callback_data: " cancel", // Split data between space with format "<data> <action>"
                    },
                  ],
                ],
              }),
            }
          )
          .then((data) => {
            users[user_id] = {
              ...users[user_id],
              upload_info: {
                url,
                filename,
                filesize: fileSize,
              },
            };
          });
      } else
        bot.sendMessage(
          chatId,
          "Failed to upload, the file you wanted to upload was too big! Please choose file with size lesser than 100GB"
        );
    } else if (msg.text.toLowerCase() === "/auth") {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
      });

      bot.sendPhoto(chatId, fs.readFileSync("./static/img/not_verified_1.png"), {
        caption: `
If you see this, that means our bot is not verified by Google, To use this bot you must trust our bot, or else you cannot fully access this bot, you can resolve this by clicking the Advanced button then the Open button. You can always remove your google account that is attached to this bot for security reasons. This message might be changed in the future


To Authorize your google account follow step by step below: 
          
1. Click 'Authorize' button and visit the link
2. Choose whichever account do you want to use
3. Allow all permissions to this bot
4. Copy the verification code and send it here
          `,
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
      });

      users[user_id] = {
        ...users[user_id],
        onAuth: true,
      };
    } else if (msg.text.toLowerCase() === "/myfiles") {
      if (!user.tokens[selected_credentials_index]) {
        return bot.sendMessage(chatId, "No account selected! enter /mydrive for more details"); 
      }

      if (!user.tokens.length) {
        return bot.sendMessage(
          chatId,
          "It seems you haven't authenticate your google account, please type /auth to do that"
        );
      }
      oAuth2Client.setCredentials(user.tokens[selected_credentials_index]);
      sendFileLists(oAuth2Client, { id: user_id });
    } else if (msg.text.toLowerCase() === "/mydrive") {
      if (!user.tokens.length)
        return bot.sendMessage(
          chatId,
          "It seems you haven't authenticate your google account, please type /auth to do that"
        );
      let accounts = [];
      let account_index = 0;
      // Validate tokens
      for (const token of user.tokens) {
        oAuth2Client.setCredentials(token);
        const info = await showUserInfo(oAuth2Client);
        accounts.push([
          {
            text: `${info ? info.emailAddress : `${token.ownership} (Revoke Required)`} ${
              selected_credentials_index === account_index ? "✅" : ""
            }`,
            callback_data: `${account_index} choose-drive`,
          },
        ]);
        account_index++;
      }

      bot.sendMessage(chatId, "Choose Your Drive to Manage", {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            ...accounts,
            [{ text: "Close", callback_data: " cancel" }],
          ],
        }),
      });
    } else if (msg.text.toLowerCase() === "/myprofile") {
      bot.sendMessage(
        chatId,
        `<pre>Username      : ${user.username}
Plan          : ${user.plan}
Drive Account : ${user.tokens.length}
Referral      : 0
 </pre>`,
        { parse_mode: "HTML" }
      );
    } else if (msg.text.toLowerCase() === "/torrent") {
      bot.sendMessage(
        chatId,
        "I can download your torrent files and upload to your google drive by sending torrent file to me"
      );
    } else if (msg.text.toLowerCase() === "/upgrade") {
      bot.sendMessage(chatId, "Coming soon!");
    } else if (msg.text.toLowerCase() === "/revoke") {
      if (!user.tokens.length) return bot.sendMessage(chatId, "There's no account to revoke!");
      bot.sendMessage(chatId, "Select Google Drive account to be removed", {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            user.tokens.map(token => { 
              return {
                text: token.ownership,
                callback_data: `${token.ownership} revoke`
              }
            }),
            [{ text: "❌ Close", callback_data: " cancel" }],
          ],
        }),
      });
    } else if (msg.text.toLowerCase() === "/revokeall") {
      if (!user.tokens.length)
        return bot.sendMessage(
          chatId,
          "Sorry! It seems you don't have any account to revoke"
        );
      bot.sendMessage(
        chatId,
        `
Are you sure ?   

This action will remove all of your google accounts accessibility to this bot
`,
        {
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
        }
      );
    } else if (msg.text.toLowerCase() === "/about") {
      bot.sendMessage(
        chatId,
        `
Hey ${user.username || ""}! Thank you for using this bot

This bot was created by @jokoprasety0. If you liked this bot please share it to anyone who needs it.

This bot is still in beta phase, and still have bugs. There are many things need be changed including the server resource, slow queue, and features!

Thanks again!
`
      );
    } else {
      bot.sendMessage(
        chatId,
        `
Unknown command!

Please type '/' to see all available command!

`
      );
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
  const chat = { id, message_id };
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
      credentials: user.tokens[user.selected_credentials_index],
      current_folder_id: user.current_folder_id || "root",
    };
  }

  if (action === "cancel") {
    users[id] = {
      ...users[id],
      onAuth: false,
    };
    bot.deleteMessage(id, message_id);
    users[id].onAuth = false;
    users[id].onCreateFile = false;
  } else if (action === "upload") {
    await User.findOneAndUpdate(
      { telegram_user_id: id },
      { $set: { current_folder_id: data } }
    );
    await bot.sendMessage(
      id,
      `
Good! You selected this directory, from now on every files you upload will be uploaded here! 

If you want to change upload directory type /myfiles and click '📤 Upload here!'
`
    );
    await bot.sendMessage(
      id,
      `
To upload file please type  /upload <url-file> 

For example:  ` +
        "`/upload 'http://speedtest.tele2.net/10GB.zip`" +
        ` The Link should be ended with extention file for example .zip, .rar, .apk, .exe and make sure that the file size is not too large with maximum of 100GB`,
      { parse_mode: "Markdown" }
    );
  } else if (action === "folder") {
    oAuth2Client.setCredentials(users[id].credentials);
    sendFileLists(oAuth2Client, chat, data, true);
  } else if (action === "file") {
    bot.editMessageText("What do you want to do with this file ?", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: "✏️ Rename File",
              callback_data: `${data} edit`,
            },
            {
              text: "❌ Delete File",
              callback_data: `${data} delete-file`,
            },
          ],
          [
            {
              text: "🔙 Back to Main Directory",
              callback_data: `root folder`,
            },
          ],
        ],
      }),
      message_id,
      chat_id: id,
    });
  } else if (action === "settings") {
    bot.editMessageText("What do you want to do with this folder ?", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: "✏️ Rename Folder",
              callback_data: `${data} edit`,
            },
            {
              text: "❌ Delete Folder",
              callback_data: `${data} delete-folder`,
            },
          ],
          [
            {
              text: "➕ Create Folder",
              callback_data: `${data} create`,
            },
            {
              text: "🔙 Back to Main Directory",
              callback_data: `root folder`,
            },
          ],
        ],
      }),
      message_id,
      chat_id: id,
    });
  } else if (action === "confirm-delete") {
    oAuth2Client.setCredentials(users[id].credentials);
    deleteFolderOrFile(oAuth2Client, data, id, message_id);
  } else if (action === "delete-file") {
    bot.editMessageText("Are you sure want to delete this file ?", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            { text: "Yes", callback_data: `${data} confirm-delete` },
            { text: "No", callback_data: `root folder` },
          ],
          [{ text: "❌ Close", callback_data: " cancel" }],
        ],
      }),
    });
  } else if (action === "delete-folder") {
    bot.editMessageText("Are you sure want to delete this folder ?", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            { text: "Yes", callback_data: `${data} confirm-delete` },
            { text: "No", callback_data: `${data} folder` },
          ],
          [{ text: "❌ Close", callback_data: " cancel" }],
        ],
      }),
    });
  } else if (action === "edit") {
    bot.editMessageText("Input your folder/file name", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "Cancel", callback_data: " cancel" }]],
      }),
    });
    users[id].onUpdateFile = true;
    users[id].last_message_id = message_id;
    users[id].choosen_parent_folder = data;
  } else if (action === "create") {
    bot.editMessageText("Input your folder name (default: 'New Folder')", {
      message_id,
      chat_id: id,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "Cancel", callback_data: " cancel" }]],
      }),
    });

    users[id].onCreateFile = true;
    users[id].last_message_id = message_id;
    users[id].choosen_parent_folder = data;
  } else if (action === "start") {
    oAuth2Client.setCredentials(users[id].credentials);
    const quota = await showUserStorageQuota(oAuth2Client);
    if (!quota)
      return bot.sendMessage(
        id,
        "Something went wrong! Please try again later."
      );
    if (quota.usageInDrive + users[id].upload_info.filesize > quota.limit)
      return bot.editMessageText(
        "Insufficient Google Drive Space! You can fix this by deleting some files in your drives.",
        {
          chat_id: id,
          message_id,
        }
      );
    const file_or_folder_exists = await checkFolderOrFileExists(
      oAuth2Client,
      users[id].current_folder_id
    );
    if (!file_or_folder_exists)
      return bot.sendMessage(
        id,
        "Folder not found! Please select an existing folder to upload!"
      );
    uploadFileQueue
      .add(
        {
          message_id,
          chat_id: id,
          url: users[id].upload_info.url,
          filename: users[id].upload_info.filename,
          filesize: users[id].upload_info.filesize,
          credentials: users[id].credentials,
          current_folder_id: users[id].current_folder_id,
        },
        { removeOnFail: true, removeOnComplete: true }
      )
      .then((job) => {
        bot.editMessageText(
          "Your file has been added to the queue, You will be notified when it's your turn!",
          {
            reply_markup: JSON.stringify({
              inline_keyboard: [
                [
                  {
                    text: "Check Queue",
                    callback_data: `${job.id} check-file-queue`,
                  },
                ],
              ],
            }),
            message_id,
            chat_id: id,
          }
        );
      });
  } else if (action === "revokeall") {
    await User.findOneAndUpdate(
      { telegram_user_id: id },
      { $set: { tokens: [] } }
    );
    bot.editMessageText(
      `
Done! ✔️
All your account access has been removed in our system! 

You can always bind your account to our bot by using /auth
`,
      {
        message_id,
        chat_id: id,
      }
    );
    users[id].credentials = null;
  } else if (action === "revoke") {
    await User.updateOne({ telegram_user_id: id }, {
      $pull: {
        tokens: {
          ownership: data
        }
      }
    }).catch(e => console.log(e));
    bot.editMessageText("Account removed!", {
      message_id,
      chat_id: id
    });

  } else if (action === "cancel-file-upload") {
    try {
      const current_active_job = await uploadFileQueue.getJob(data);
      await current_active_job.moveToCompleted({
        message: `Action cancelled successfully!`,
        message_id,
        chat_id: id,
      });
    } catch (e) {
      console.log(e.message);
    }
  } else if (action === "start-torrent") {
    const uploadTorrentJob = await uploadTorrentQueue.add(
      {
        url: data,
        identifier: uuidv4(),
        message_id,
        chat_id: id,
        user_folder_id: users[id].current_folder_id,
        credentials: users[id].credentials,
      },
      {
        removeOnFail: true,
        removeOnComplete: true,
      }
    );
    bot.editMessageText("Your torrent file has been added to the queue!", {
      chat_id: id,
      message_id,
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: "Check Queue",
              callback_data: `${uploadTorrentJob.id} check-torrent-queue`,
            },
            {
              text: "Cancel",
              callback_data: `${uploadTorrentJob.id} cancel-torrent-upload`,
            },
          ],
        ],
      }),
    });
  } else if (action === "check-torrent-queue") {
    let activeJobs = await uploadTorrentQueue.getActive();
    const waitingJobsCount = await uploadTorrentQueue.getWaitingCount();
    activeJobs = activeJobs.map((job) => {
      return {
        id: job.id,
        processedOn: new Date(job.processedOn),
      };
    });

    let activeJobInfoStr = "Currently this bot is serving queues number: ";
    activeJobs.forEach((job, index) => {
      console.log(job.id);
      if (index === activeJobs.length - 1) activeJobInfoStr += `${job.id}`;
      else activeJobInfoStr += `${job.id}, `;
    });
    console.log(activeJobInfoStr);
    bot.answerCallbackQuery({
      callback_query_id: query.id,
      text: `
This torrent is on queue number ${data}
${activeJobInfoStr}

There're currently ${waitingJobsCount} torrent(s) are waiting to be uploaded
      `,
      show_alert: true,
    });
  } else if (action === "cancel-torrent-upload") {
    try {
      const current_active_job = await uploadTorrentQueue.getJob(data);
      await current_active_job.discard();
      if (await current_active_job.isWaiting()) {
        await current_active_job.remove();
        return bot.editMessageText(
          "Your torrent has been removed from the queue!",
          {
            chat_id: id,
            message_id,
          }
        );
      }
      await current_active_job.moveToFailed(
        new Error(`${current_active_job.data.identifier}_Action Cancelled Successfully!_${message_id}_${id}`)
      );
    } catch (e) {
      console.log(e.message);
    }
  } else if (action === "check-file-queue") {
    let activeJobs = await uploadFileQueue.getActive();
    const waitingJobsCount = await uploadFileQueue.getWaitingCount();
    activeJobs = activeJobs.map((job) => {
      return {
        id: job.id,
        processedOn: new Date(job.processedOn),
      };
    });

    let activeJobInfoStr = "Currently this bot is serving queues number: ";
    activeJobs.forEach((job, index) => {
      if (index === activeJobs.length - 1) activeJobInfoStr += `${job.id}`;
      else activeJobInfoStr += `${job.id}, `;
    });
    bot.answerCallbackQuery({
      callback_query_id: query.id,
      text: `
This file is on queue number ${data}
${activeJobInfoStr}

There're currently ${waitingJobsCount} file(s) are waiting to be uploaded
      `,
      show_alert: true,
    });
  } else if (action === "choose-drive") {
    await User.updateOne(
      { telegram_user_id: id },
      { $set: { selected_credentials_index: data } },
      (err) => {
        if (err)
          return bot.editMessageText(
            "Something went wrong, Cannot select drive account!",
            {
              chat_id: id,
              message_id,
            }
          );

        bot.editMessageText("Successfully selected drive account!", {
          chat_id: id,
          message_id,
        });
      }
    );
  } else if (!users[id].credentials) {
    return bot.sendMessage(chat.id, "No account selected! enter /mydrive for more details");
  }

});

// Debugging
// setInterval(async () => {
//   // const jobs = await uploadTorrentQueue.getJobCounts();
//   // console.log(jobs);
//   const used = process.memoryUsage();
//   for (let key in used) {
//     console.log(`${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
//   }
//   console.log("\n");
// }, 2000)

server.listen(PORT, () => console.log("Listening on PORT", PORT));
