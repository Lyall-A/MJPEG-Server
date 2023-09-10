// Import internal libraries
const { spawn } = require("child_process");
const { readFileSync, existsSync } = require("fs");
const { createServer } = require("http");

const defaultImage = existsSync("./default.jpg") ? readFileSync("./default.jpg") : undefined; // Import default image that will be displayed if no camera could be detected if exists
const server = createServer(); // Create HTTP server
const clients = {};

// Arg parser
const rawArgs = process.argv;
rawArgs.splice(0, 2);
const args = {};
rawArgs.forEach((arg, i) => {
    const nextArg = rawArgs[i + 1];
    if (arg.startsWith("-")) args[arg.substring(1)] = (nextArg ? (nextArg.startsWith("-") ? null : nextArg) : null);
});

// Args
const port = args.port || 1234;
const startDelay = args.delay || 5000;
const input = args.input || args.i || "/dev/video0";
const fps = args.fps || args.framerate;
const bitrate = args.bitrate;
const resolution = args.res || args.resolution;
const filters = args.filters;
const format = args.format || "image2";
const inputFormat = args.inputformat || args.iformat || "mjpeg";
const output = args.output || args.o || `http://localhost:${port}/mjpeg`;

console.log(`Starting with args '${rawArgs.join(" ")}'`);

// Do not continue if input or output args where not specified
if (!input) return console.log("No input specified!");
if (!output) return console.log("No output specified!");

const ffmpegArgs = `-y -i ${input} -an ${fps ? `-r ${fps} ` : ""}${resolution ? `-s ${resolution} ` : ""}${filters ? `-vf eq=${filters} ` : ""}-update 1 ${format ? `-f ${format} ` : ""}${inputFormat ? `-input_format ${inputFormat} ` : ""}${bitrate ? `-b:v ${bitrate} ` : ""}${output}`; // FFmpeg args

let lastFrame;
let timeout;

server.on("request", (req, res) => {
    switch (req.method) {
        case "GET":
            // GET requests
            switch (req.url) {
                case "/":
                    // Page '/'
                    // Send HTML page
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(`<body style="margin: 0; padding: 0; background-color: black;"><img src="/mjpeg" style="height: 100vh; display: block; margin-left: auto; margin-right: auto;"</body>`)
                    break;
                case "/still":
                    // Page '/still'
                    // Send last frame
                    res.writeHead(200, { "Content-Type": "image/jpeg" });
                    res.end(lastFrame || defaultImage);
                    break;
                case "/mjpeg":
                    // Page '/mjpeg'
                    // Live view of MJPEG

                    // Write 200 status with headers
                    res.writeHead(200, {
                        "Content-Type": "multipart/x-mixed-replace; boundary=stream",
                        "Cache-Control": "no-cache"
                    });

                    res.frames = 0; // Sent frames to client
                    const clientId = genClientId(res); // Generate client ID

                    sendCameraData(lastFrame || defaultImage, res); // Send last frame 

                    console.log(`HTTP: New client ID ${clientId}`);

                    res.on("close", () => {
                        // Delete client when client disconnects
                        console.log(`HTTP: Client ID ${clientId} has closed`);
                        delete clients[clientId];
                    });
                    break;
                default:
                    // Unknown page
                    // Send 404 page
                    res.writeHead(404, { "Content-Type": "text/plain" });
                    res.end(`Page not found`);
                    break;
            }
            break;
        case "POST":
            // POST requests
            switch (req.url) {
                case "/mjpeg":
                    // Page '/mjpeg'
                    // Upload MJPEG frame

                    // Get JPEG frame
                    let data;
                    req.on("data", d => {
                        data ? data = Buffer.concat([data, d]) : data = Buffer.from(d);
                    });

                    req.on("end", () => {
                        // Once data has finished

                        // Verify that frame is JPEG (weak)

                        /* JPEG header:
                            Start:  FF D8
                            End:    FF D9
                        */
                        if (data[0] != 0xFF || data[1] != 0xD8 || data[data.length - 2] != 0xFF || data[data.length - 1] != 0xD9) {
                            res.writeHead(400, { "Content-Type": "text/plain" });
                            res.end("Not JPEG format");
                        }

                        // Alert every 10 seconds if a new frame has not been received
                        clearTimeout(timeout);
                        (function lastFrameAlert(time = 10) {
                            timeout = setTimeout(() => {
                                console.log(`Frame has not been received in ${time} seconds!`);
                                lastFrameAlert(time + 10);  
                            }, 10 * 1000);
                        })();

                        lastFrame = data;
                        sendCameraData(); // Send frame to all MJPEG clients
                    });
                    break;
                default:
                    // Unknown page
                    // Send 404 page
                    res.writeHead(404, { "Content-Type": "text/plain" });
                    res.end(`Page not found`);
                    break;
            }
            break;
        default:
            // Invalid method
            // Send 404 page
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end(`Page not found`);
            break;
    }
});

// FFmpeg instance
(function startRecording() {
    const ffmpeg = spawn("ffmpeg", ffmpegArgs.split(" ")); // Create instance

    let lastOutput; // Last FFmpeg output
    ffmpeg.stderr.on("data", data => {
        lastOutput = data.toString();
        //console.log(`FFmpeg: ${data.toString().replace(/\n/g, "\nFFmpeg: ")}`)
    });
    console.log(`Starting recording with args '${ffmpegArgs}'...`); // Log

    // FFmpeg closed
    ffmpeg.on("exit", () => {
        lastFrame = null; // Delete last frame
        sendCameraData(); // Send default image to all MJPEG clients
        console.log(`FFmpeg closed! Restarting in ${startDelay / 1000}s\n${lastOutput || "No FFmpeg output"}`);
        setTimeout(() => startRecording(), startDelay); // Restart after x seconds
    });
})();

// Send camera data to MJPEG client(s)
function sendCameraData(data = (lastFrame || defaultImage), client) {
    if (!data) return; // No data (no last frame or default image)

    if (!client) {
        // Send data to all MJPEG clients
        Object.values(clients).forEach(client => {
            if (!client?.writable) return;
            if (client.frames) client.write("\r\n\r\n");
            client.write("--stream\r\n");
            client.write("Content-Type: image/jpeg\r\n");
            client.write(`Content-Length: ${data.length}\r\n\r\n`);
            client.write(data);
            client.frames++;
        });
    } else {
        // Send data to MJPEG client
        if (!client?.writable) return;
        if (client.frames) client.write("\r\n\r\n");
        client.write("--stream\r\n");
        client.write("Content-Type: image/jpeg\r\n");
        client.write(`Content-Length: ${data.length}\r\n\r\n`);
        client.write(data);
        client.frames++;
    }
}

// Create client ID
function genClientId(client) {
    const id = Math.floor(Math.random() * 1000000000);
    if (clients[id]) return genClientId();
    clients[id] = client;
    return id;
}

server.listen(port, err => err ? console.error(err) : console.log(`Listening on port ${port}`)); // Start HTTP seerver on port