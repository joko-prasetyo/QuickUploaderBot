const fs = require("fs");
const request = require("request");
const progress = require("request-progress");
const dir = "./shared";
fs.mkdirSync(dir, { recursive: true });
const writer = fs.createWriteStream("./shared/dummy.bin");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

writer.on("close", () => {
  console.log("all done, deleting all shared files");
  fs.readdir(dir, (err, files) => {
    if (err) throw err;

    for (const file of files) {
      fs.unlink(path.join(dir, file), (err) => {
        if (err) throw err;
      });
    }
  });
});

rl.question(
  "Enter Url to download. The file must ended up with any file extension ",
  (url) => {
    progress(request(url))
      .on("progress", function (state) {
        console.log("progress", state);
      })
      .on("error", function (err) {
        // Do something with err
        console.log(err);
      })
      .pipe(writer);

    rl.close();
  }
);
