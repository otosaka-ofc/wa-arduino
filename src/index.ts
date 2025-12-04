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

const logger = pino({
    level: "silent",
    transport: { target: "pino-pretty", options: { colorize: true } },
});

// =========================================
// 📌 VARIABLES GLOBALES — ULTIMAS LECTURAS
// =========================================
let serialPort: SerialPort;
let parser: ReadlineParser;

let lastTemperature: { temperature: number; humedity: number } | null = null;
let lastDistance: { distance_front: number; distance_back: number } | null =
    null;
let lastLight: { light_direction: string; light_intensity: number } | null =
    null;
let lastSteering: string | null = null;
let lastSound: number | null = null;
let lastRain: number | null = null;
let lastAction: string | null = null;

// 🆕 ESTADO DE LAS ALARMAS
let lastAlarmState: boolean | null = null;
let lastFollowLightState: boolean | null = null;

// =========================================
// 📌 PROCESAR LÍNEA DEL ARDUINO SIEMPRE
// =========================================
function handleIncomingLine(line: string) {
    try {
        const data = JSON.parse(line);

        if (data.temperature !== undefined) {
            lastTemperature = {
                temperature: data.temperature,
                humedity: data.humedity,
            };
        }

        if (data.distance_front !== undefined) {
            lastDistance = {
                distance_front: data.distance_front,
                distance_back: data.distance_back,
            };
        }

        if (data.light_direction !== undefined) {
            lastLight = {
                light_direction: data.light_direction,
                light_intensity: lastLight?.light_intensity ?? 0,
            };
        }

        if (data.light_intensity !== undefined) {
            lastLight = {
                light_direction: lastLight?.light_direction ?? "NINGUNA",
                light_intensity: data.light_intensity,
            };
        }

        if (data.steering_status !== undefined)
            lastSteering = data.steering_status;

        if (data.sound_level !== undefined) lastSound = data.sound_level;

        if (data.rain_level !== undefined) lastRain = data.rain_level;

        if (data.last_action !== undefined) lastAction = data.last_action;

        // 🆕 CAPTURA EL ESTADO DE ALARMAS
        if (data.alarm_status !== undefined) lastAlarmState = data.alarm_status;
        if (data.follow_light !== undefined)
            lastFollowLightState = data.follow_light;
    } catch {
        // no es JSON
    }
}

// =========================================
// 📌 FORMATO BONITO PARA /all
// =========================================
function prettyAll() {
    return `
📊 *ESTADO COMPLETO DEL CARRITO TECNOLÓGICO 🚗*

🌡 *Temperatura:* ${lastTemperature?.temperature ?? "??"} °C
💧 *Humedad:* ${lastTemperature?.humedity ?? "??"} %

📏 *Distancia Frente:* ${lastDistance?.distance_front ?? "??"} cm
📏 *Distancia Atrás:* ${lastDistance?.distance_back ?? "??"} cm

🔦 *Dirección de Luz:* ${lastLight?.light_direction ?? "??"}
💡 *Intensidad de Luz:* ${lastLight?.light_intensity ?? "??"}

🛞 *Timon:* ${lastSteering ?? "??"}
🎮 *Última acción:* ${lastAction ?? "??"}

🔊 *Nivel de sonido:* ${lastSound ?? "??"}
🌧 *Nivel de lluvia:* ${lastRain ?? "??"}

🚨 *Alarmas:* ${
        lastAlarmState === null
            ? "??"
            : lastAlarmState
            ? "ACTIVADAS"
            : "DESACTIVADAS"
    }
🚗 *Seguir Luces:* ${
        lastFollowLightState === null
            ? "??"
            : lastFollowLightState
            ? "ACTIVADO"
            : "DESACTIVADO"
    }
`;
}

// =========================================
// 📌 MENÚ — AHORA CON ALARMAS
// =========================================
const commandMenu = `
📌 *COMANDOS DISPONIBLES*

/temp → Temperatura & humedad
/dist → Distancias
/luz → Dirección de luz
/intensidad → Intensidad de luz
/timon → Estado del timón
/accion → Última acción
/sonido → Nivel de sonido
/lluvia → Nivel de lluvia
/alarmas → Activar/desactivar alarmas
/estado_alarmas → Ver si están ON/OFF
/seguir → Activar o desactivar Seguir Luces ON/OFF

/all → Todo el estado del carrito
/menu → Lista de comandos
/help → Lista de comandos
`;

// =========================================
// 🚀 INICIO
// =========================================
async function init(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(
        "baileys_auth_info"
    );

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        browser: Browsers.macOS("Safari"),
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
    });

    sock.ev.process(async (events) => {
        if (events["connection.update"]) {
            const update = events["connection.update"];
            const { connection, lastDisconnect, qr } = update;

            if (qr) qrcode.generate(qr, { small: true });

            if (connection === "close") {
                if (
                    (lastDisconnect?.error as Boom)?.output.statusCode !==
                    DisconnectReason.loggedOut
                )
                    init();
                else console.log("Logged out.");
            } else if (connection == "open") {
                await sock.sendMessage("51993966345@s.whatsapp.net", {
                    text: "🚗 Robert listo!!! 🚗",
                });
            }
        }

        if (events["creds.update"]) await saveCreds();

        if (events["messages.upsert"]) {
            const upsert = events["messages.upsert"];
            if (upsert.type !== "notify") return;

            for (const msg of upsert.messages) {
                if (msg.key.fromMe) continue;

                const text =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    "";

                if (!text) continue;

                sock.readMessages([msg.key]);

                const parts = text.trim().toLowerCase().split(" ");
                const command = parts[0]?.replace("/", "");
                const args = parts.slice(1);
                const chat = msg.key.remoteJid!;

                switch (command) {
                    case "conectar": {
                        const path = (args[0] ?? "COM3") as
                            | "COM1"
                            | "COM2"
                            | "COM3";
                        const baudRate = parseInt(args[1] ?? "9600");

                        serialPort = createPort({ path, baudRate });
                        parser = serialPort.pipe(
                            new ReadlineParser({ delimiter: "\n" })
                        );
                        parser.on("data", handleIncomingLine);

                        await sock.sendMessage(chat, {
                            text: `🔌 Conectado a *${path}* correctamente.`,
                        });
                        break;
                    }

                    case "temp":
                        await sock.sendMessage(chat, {
                            text: lastTemperature
                                ? `🌡 *Temperatura:* ${lastTemperature.temperature} °C\n💧 *Humedad:* ${lastTemperature.humedity} %`
                                : "⚠ No hay datos de temperatura.",
                        });
                        break;

                    case "dist":
                        await sock.sendMessage(chat, {
                            text: lastDistance
                                ? `📏 *Delante:* ${lastDistance.distance_front} cm\n📏 *Atrás:* ${lastDistance.distance_back} cm`
                                : "⚠ No hay datos de distancia.",
                        });
                        break;

                    case "luz":
                        await sock.sendMessage(chat, {
                            text: lastLight
                                ? `🔦 *Dirección de luz:* ${lastLight.light_direction}`
                                : "⚠ No hay datos de dirección de luz.",
                        });
                        break;

                    case "intensidad":
                        await sock.sendMessage(chat, {
                            text: lastLight
                                ? `💡 *Intensidad de luz:* ${lastLight.light_intensity}`
                                : "⚠ No hay intensidad registrada.",
                        });
                        break;

                    case "timon":
                        await sock.sendMessage(chat, {
                            text: lastSteering
                                ? `🛞 *Timon:* ${lastSteering}`
                                : "⚠ No hay datos del timón.",
                        });
                        break;

                    case "accion":
                        await sock.sendMessage(chat, {
                            text: lastAction
                                ? `🎮 *Última acción:* ${lastAction}`
                                : "⚠ No hay acción registrada.",
                        });
                        break;

                    case "sonido":
                        await sock.sendMessage(chat, {
                            text:
                                lastSound !== null
                                    ? `🔊 *Nivel de sonido:* ${lastSound}`
                                    : "⚠ No hay datos de sonido.",
                        });
                        break;

                    case "lluvia":
                        await sock.sendMessage(chat, {
                            text:
                                lastRain !== null
                                    ? `🌧 *Nivel de lluvia:* ${lastRain}`
                                    : "⚠ No hay datos de lluvia.",
                        });
                        break;

                    // =======================================================
                    // 🆕 NUEVO COMANDO: ver estado de alarmas desde WhatsApp
                    // =======================================================
                    case "estado_alarmas":
                        await sock.sendMessage(chat, {
                            text:
                                lastAlarmState === null
                                    ? "⚠ No hay datos del estado de alarmas."
                                    : lastAlarmState
                                    ? "🚨 Alarmas *ACTIVADAS*"
                                    : "🟢 Alarmas *DESACTIVADAS*",
                        });
                        break;
                    case "estado_seguir":
                        await sock.sendMessage(chat, {
                            text:
                                lastFollowLightState === null
                                    ? "⚠ No hay datos del estado de Seguir Luces."
                                    : lastFollowLightState
                                    ? "🚨 Seguir Luces *ACTIVADO*"
                                    : "🟢 Seguir Luces *DESACTIVADO*",
                        });
                        break;
                    case "seguir":
                        if (!serialPort) return;

                        if (args[0] == "off") {
                            serialPort.write("no_seguir\n");
                            await sock.sendMessage(chat, {
                                text: "🟢 Seguir luces desactivadas, no se seguirá ninguna luz.",
                            });
                        } else if (args[0] == "on") {
                            serialPort.write("seguir_luz\n");
                            await sock.sendMessage(chat, {
                                text: "🚨 Seguir luces Activadas, se seguirán todas las luces.",
                            });
                        }
                        break;
                        break;

                    case "alarmas":
                        if (!serialPort) return;

                        if (args[0] == "off") {
                            serialPort.write("alarmas_off\n");
                            await sock.sendMessage(chat, {
                                text: "🟢 Alarmas desactivadas",
                            });
                        } else if (args[0] == "on") {
                            serialPort.write("alarmas_on\n");
                            await sock.sendMessage(chat, {
                                text: "🚨 Alarmas activadas",
                            });
                        }
                        break;

                    case "all":
                        await sock.sendMessage(chat, {
                            text: prettyAll(),
                        });
                        break;

                    case "menu":
                    case "help":
                        await sock.sendMessage(chat, { text: commandMenu });
                        break;

                    default:
                        await sock.sendMessage(chat, {
                            text: `❓ Comando desconocido: *${command}*`,
                        });
                        break;
                }
            }
        }
    });
}

init();
