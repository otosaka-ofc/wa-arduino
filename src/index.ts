import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { ReadlineParser, type SerialPort } from "serialport";
import { createPort } from "./serialPort";
// import port from "./serialPort";

const logger = pino({
    level: "silent",
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
        },
    },
});

let serialPort: SerialPort;
let parser: ReadlineParser;

async function init(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(
        "baileys_auth_info"
    );

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        browser: Browsers.windows("Brave"),
        logger: logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
    });

    sock.ev.process(async (events) => {
        if (events["connection.update"]) {
            const update = events["connection.update"];
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrcode.generate(qr, { small: true }, (qrcode: string) => {
                    console.log("Scan the QR Code:\n", qrcode);
                });
            }

            if (connection === "close") {
                if (
                    (lastDisconnect?.error as Boom)?.output.statusCode !==
                    DisconnectReason.loggedOut
                ) {
                    init();
                } else {
                    console.log("Connection closed. You are logged out.");
                }
            } else if (connection === "open") {
                await sock.sendMessage("51993966345@s.whatsapp.net", {
                    text: "Hello! Bot is now connected.",
                });
            }
        }
        if (events["creds.update"]) await saveCreds();

        if (events["messages.upsert"]) {
            const upsert = events["messages.upsert"];
            // console.log("Got messages upsert", upsert);
            if (upsert.type === "notify") {
                for (const msg of upsert.messages) {
                    if (msg.key.fromMe) return;
                    if (
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text
                    ) {
                        sock.readMessages([msg.key]);
                        const text =
                            msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            "";

                        const tokenized = text.trim().toLowerCase().split(" ");
                        const prefix = "/";
                        const command = tokenized[0]
                            ?.trimStart()
                            .slice(prefix.length);
                        const commandArguments = tokenized.slice(1);

                        const catchTemperature = async (data: string) => {
                            try {
                                const dataParsed = JSON.parse(data);
                                if (
                                    dataParsed.temperature &&
                                    dataParsed.humedity
                                ) {
                                    await sock.sendMessage(
                                        msg.key.remoteJid!,
                                        {
                                            text: `Temperatura actual: ${dataParsed.temperature} C°\nHumedad:${dataParsed.humedity} %`,
                                        },
                                        { quoted: msg }
                                    );
                                    parser.off("data", catchTemperature);
                                }
                            } catch (e) {
                                await sock.sendMessage(
                                    msg.key.remoteJid!,
                                    {
                                        text: `Error convirtiendo: ${e.message}`,
                                    },
                                    { quoted: msg }
                                );
                                parser.off("data", catchTemperature);
                            }
                        };
                        const catchDistance = async (data: string) => {
                            try {
                                const dataParsed = JSON.parse(data);
                                if (
                                    dataParsed.distance_front &&
                                    dataParsed.distance_back
                                ) {
                                    await sock.sendMessage(
                                        msg.key.remoteJid!,
                                        {
                                            text: `Distancia en la parte tracera: ${dataParsed.distance_back} cm\nDistancia en la parte delantera:${dataParsed.distance_front} cm`,
                                        },
                                        { quoted: msg }
                                    );
                                    parser.off("data", catchTemperature);
                                }
                            } catch (e) {
                                await sock.sendMessage(
                                    msg.key.remoteJid!,
                                    {
                                        text: `Error convirtiendo: ${e.message}`,
                                    },
                                    { quoted: msg }
                                );
                                parser.off("data", catchDistance);
                            }
                        };

                        switch (command) {
                            case "ping":
                                await sock.sendMessage(
                                    msg.key.remoteJid!,
                                    {
                                        text: "pong",
                                    },
                                    { quoted: msg }
                                );
                                break;
                            case "temp":
                                if (serialPort) {
                                    parser.on("data", catchTemperature);
                                }
                                break;
                            case "dist":
                                if (serialPort) {
                                    parser.on("data", catchDistance);
                                }
                                break;
                            case "connect": {
                                const path = commandArguments[0] as
                                    | "COM1"
                                    | "COM2"
                                    | "COM3";
                                const baudRate = parseInt(
                                    commandArguments[1] ?? "9600"
                                );

                                serialPort = createPort({ path, baudRate });
                                parser = serialPort.pipe(
                                    new ReadlineParser({ delimiter: "\n" })
                                );
                                if (serialPort)
                                    sock.sendMessage(
                                        msg.key.remoteJid!,
                                        {
                                            text: "Connected Successfully",
                                        },
                                        { quoted: msg }
                                    );
                                break;
                            }
                            default:
                                await sock.sendMessage(
                                    msg.key.remoteJid!,
                                    {
                                        text: `Unknown command: ${command}`,
                                    },
                                    { quoted: msg }
                                );
                                break;
                        }
                    }
                }
            }
        }
    });
}

init();
