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
                // port?.on("open", async() => {
                //     await sock.sendMessage("51993966345@s.whatsapp.net", {
                //         text: "Serial Port is now open.",
                //     });
                // });
                // port?.on("error", async(err) => {
                //     await sock.sendMessage("51993966345@s.whatsapp.net", {
                //         text: `Serial Port error: ${err.message}`,
                //     });
                // });
            }
            // console.log("Connection update", update);
        }
        if (events["creds.update"]) await saveCreds();

        if (events["messages.upsert"]) {
            const upsert = events["messages.upsert"];
            // console.log("Got messages upsert", upsert);
            if (upsert.type === "notify") {
                for (const msg of upsert.messages) {
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
                            case "info":
                                await sock.sendMessage(
                                    msg.key.remoteJid!,
                                    {
                                        text: `You are using Baileys WA v${version.join(
                                            "."
                                        )}`,
                                    },
                                    { quoted: msg }
                                );
                                break;
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
