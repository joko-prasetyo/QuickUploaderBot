// const fs = require("fs");
// const request = require("request");
// const progress = require("request-progress");
// const dir = "./shared";
// fs.mkdirSync(dir, { recursive: true });
// const writer = fs.createWriteStream("./shared/dummy.bin");
// const path = require("path");
// const readline = require("readline");

// const rl = readline.createInterface({
//   input: process.stdin,
//   output: process.stdout,
// });

// writer.on("close", () => {
//   console.log("all done, deleting all shared files");
//   fs.readdir(dir, (err, files) => {
//     if (err) throw err;

//     for (const file of files) {
//       fs.unlink(path.join(dir, file), (err) => {
//         if (err) throw err;
//       });
//     }
//   });
// });

// rl.question(
//   "Enter Url to download. The file must ended up with any file extension ",
//   (url) => {
//     progress(request(url))
//       .on("progress", function (state) {
//         console.log("progress", state);
//       })
//       .on("error", function (err) {
//         // Do something with err
//         console.log(err)
//       })
//       .pipe(writer);

//     rl.close();
//   }
// );

// const fs = require("fs");
// const { google } = require("googleapis");

// // If modifying these scopes, delete token.json.
// const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
// const TOKEN_PATH = "token.json";

// /**
//  * Create an OAuth2 client with the given credentials, and then execute the given callback function.
//  */
// function authorize(credentials, callback) {
//   const { client_secret, client_id, redirect_uris } = credentials.installed;
//   const oAuth2Client = new google.auth.OAuth2(
//     client_id,
//     client_secret,
//     redirect_uris[0]
//   );

//   // Check if we have previously stored a token.
//   fs.readFile(TOKEN_PATH, (err, token) => {
//     if (err) return getAccessToken(oAuth2Client, callback);
//     oAuth2Client.setCredentials(JSON.parse(token));
//     callback(oAuth2Client);
//   });
// }

// /**
//  * Get and store new token after prompting for user authorization, and then
//  * execute the given callback with the authorized OAuth2 client.
//  * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
//  * @param {getEventsCallback} callback The callback for the authorized client.
//  */
// function getAccessToken(oAuth2Client, callback) {
//   const authUrl = oAuth2Client.generateAuthUrl({
//     access_type: "offline",
//     scope: SCOPES,
//   });
//   console.log("Authorize this app by visiting this url:", authUrl);
//   const rl = readline.createInterface({
//     input: process.stdin,
//     output: process.stdout,
//   });
//   rl.question("Enter the code from that page here: ", (code) => {
//     rl.close();
//     oAuth2Client.getToken(code, (err, token) => {
//       if (err) return console.error("Error retrieving access token", err);
//       oAuth2Client.setCredentials(token);
//       // Store the token to disk for later program executions
//       fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
//         if (err) return console.error(err);
//         console.log("Token stored to", TOKEN_PATH);
//       });
//       callback(oAuth2Client);
//     });
//   });
// }
// /**
//  * Describe with given media and metaData and upload it using google.drive.create method()
//  */
// function uploadFile(auth) {
//   const drive = google.drive({ version: "v3", auth });
//   const fileMetadata = {
//     name: "10MB.zip",
//   };
//   const media = {
//     mimeType: "application/octet-stream",
//     body: fs.createReadStream("shared/10MB.zip"),
//   };
//   drive.files.create(
//     {
//       resource: fileMetadata,
//       media: media,
//       fields: "id",
//     },
//     (err, file) => {
//       if (err) {
//         // Handle error
//         console.error(err);
//       } else {
//         console.log("File Id: ", file.id);
//       }
//     }
//   );
// }

// fs.readFile("credentials.json", (err, content) => {
//   if (err) return console.log("Error loading client secret file:", err);
//   // Authorize a client with credentials, then call the Google Drive API.
//   authorize(JSON.parse(content), uploadFile);
// });

// const { infoHash } = parseTorrent(buffer);
// const uri = parseTorrent.toMagnetURI({
//   infoHash,
// });

// const engine = torrentStream(uri, {
//   path: torrent_downloaded_files_dir,
//   verify: false,
// });

// engine.on("ready", function (e) {
//   const interval = setInterval(async () => {
//     if (streamEnded || timeoutSeconds >= maximumTimeoutSeconds) {
//       clearInterval(interval);
//       engine.destroy(() => {
//         engine.remove(false, () => {
//           return done(null, {
//             message:
//               "Sorry, Our bot canceled the process, because the torrent stayed on a download speed of 0 kb for 30 mins. Remember that not all torrents are working properly, sometimes the torrent might be very slow to download or broken. To resolve this please choose higher torrent seeders or choose another torrent.",
//             message_id,
//             chat_id,
//           });
//         });
//       });
//     }

//     if (!current_download_speed) {
//       timeoutSeconds += 2;
//     } else {
//       timeoutSeconds = 0;
//     }
//   }, 2000);
//   engine.files.forEach(async function (file) {
//     console.log("filename:", file.name + " " + filesize(file.length));
//     const readStream = file.createReadStream();
//     let download_path =
//       torrent_downloaded_files_dir +
//       "/" +
//       file.path
//         .split("/")
//         .filter((item) => item != file.name)
//         .join("/");
//     await mkdirp(download_path);
//     const writeStream = fs.createWriteStream(
//       torrent_downloaded_files_dir + "/" + file.path
//     );

//     const str = progress_stream({
//       length: file.length,
//       time: 100,
//     });

//     str.on("progress", async function (progress) {
//       let isActive = await job.isActive();
//       if (!isActive) {
//         streamEnded = true;
//         return str.end();
//       }
//       current_download_speed = progress.speed;
//       bot
//         .editMessageText(
//           `
// *Downloading*: ` +
//             "`" +
//             file.name +
//             "` (" +
//             filesize(file.length) +
//             ")" +
//             `

// *Download Speed*: ${filesize(progress.speed)}/s

// *Downloaded*: ${filesize(engine.swarm.downloaded)}

// *Percentage Downloaded*: ${progress.percentage.toFixed(2)}%

// *ETA*: ${progress.eta.toFixed(2)}s
//         `,
//           {
//             chat_id,
//             message_id,
//             parse_mode: "Markdown",
//             reply_markup: JSON.stringify({
//               inline_keyboard: [
//                 [
//                   {
//                     text: "Cancel",
//                     callback_data: `${job.id} cancel-torrent-upload`,
//                   },
//                 ],
//               ],
//             }),
//           }
//         )
//         .catch((e) => {
//           console.log("Cannot edit message!");
//         });
//     });
//     readStream.pipe(str).pipe(writeStream);
//     readStream.on("end", () => {
//       console.log(file.name + " Finished Downloading");
//     });
//   });
// });

// engine.on("idle", async () => {
//   console.log("All Download Finished!");
//   streamEnded = true;
//   bot
//     .editMessageText(
//       `
// Download completed!

// Uploading files to your drive...`,
//       {
//         chat_id,
//         message_id,
//       }
//     )
//     .catch(() => {
//       console.log("Cannot edit message!");
//     });
//   await sleep(5000);
//   oAuth2Client.setCredentials(credentials);
//   await uploadFolderToDriveJob(
//     oAuth2Client,
//     user_folder_id,
//     torrent_downloaded_files_dir,
//     { job, done }
//   );
// });

var Client = require('bittorrent-tracker')

var requiredOpts = {
  infoHash: Buffer.from("012345678901234567890", 'hex'), // hex string or Buffer
  peerId: Buffer.from("01234567890123456789", 'hex'), // hex string or Buffer
  announce: [], // list of tracker server urls
  port: 6881 // torrent client port, (in browser, optional)
}

var optionalOpts = {
  getAnnounceOpts: function () {
    // Provide a callback that will be called whenever announce() is called
    // internally (on timer), or by the user
    return {
      uploaded: 0,
      downloaded: 0,
      left: 0,
      customParam: 'blah' // custom parameters supported
    }
  },
  // RTCPeerConnection config object (only used in browser)
  rtcConfig: {},
  // User-Agent header for http requests
  userAgent: '',
  // Custom webrtc impl, useful in node to specify [wrtc](https://npmjs.com/package/wrtc)
  wrtc: {},
}

var client = new Client(requiredOpts)

client.on('error', function (err) {
  // fatal client error!
  console.log(err.message)
})

client.on('warning', function (err) {
  // a tracker was unavailable or sent bad data to the client. you can probably ignore it
  console.log(err.message)
})

// start getting peers from the tracker
client.start()

client.on('update', function (data) {
  console.log('got an announce response from tracker: ' + data.announce)
  console.log('number of seeders in the swarm: ' + data.complete)
  console.log('number of leechers in the swarm: ' + data.incomplete)
})

client.once('peer', function (addr) {
  console.log('found a peer: ' + addr) // 85.10.239.191:48623
})

// announce that download has completed (and you are now a seeder)
client.complete()

// force a tracker announce. will trigger more 'update' events and maybe more 'peer' events
client.update()

// provide parameters to the tracker
client.update({
  uploaded: 0,
  downloaded: 0,
  left: 0,
  customParam: 'blah' // custom parameters supported
})

// stop getting peers from the tracker, gracefully leave the swarm
client.stop()

// ungracefully leave the swarm (without sending final 'stop' message)
client.destroy()

// scrape
client.scrape()

client.on('scrape', function (data) {
  console.log('got a scrape response from tracker: ' + data.announce)
  console.log('number of seeders in the swarm: ' + data.complete)
  console.log('number of leechers in the swarm: ' + data.incomplete)
  console.log('number of total downloads of this torrent: ' + data.downloaded)
})