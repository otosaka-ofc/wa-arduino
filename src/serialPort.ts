import { SerialPort } from "serialport";

export function createPort(options: {
    path: "COM1" | "COM2" | "COM3";
    baudRate: number;
}): SerialPort {
    const port: SerialPort = new SerialPort({
        path: options.path,
        baudRate: options.baudRate,
    });
    return port;
}
