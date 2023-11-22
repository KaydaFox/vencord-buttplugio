/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Needed header for all plugins

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { makeRange } from "@components/PluginSettings/components";
import { getCurrentChannel, getCurrentGuild, sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";
import { ButtplugBrowserWebsocketClientConnector, ButtplugClient, ButtplugClientDevice, ButtplugDeviceError } from "buttplug";
import { Message } from "discord-types/general";
import type { PartialDeep } from "type-fest";

function isValidWebSocketUrl(url: string): boolean {
    // Regular expression for WebSocket URL validation
    const webSocketUrlPattern = /^wss?:\/\/[^\s/$.?#].[^\s]*$/;

    // Test the URL against the pattern
    return webSocketUrlPattern.test(url);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let client: ButtplugClient | null = null;
let connector: ButtplugBrowserWebsocketClientConnector;
let batteryIntervalId: NodeJS.Timeout | null = null;
let vibrateQueue: VibrateEvent[] = [];
const recentlyHandledMessages: string[] = [];

const pluginSettings = definePluginSettings({
    connectAutomatically: {
        type: OptionType.BOOLEAN,
        description: "If true, it will connect to intiface on startup. (With this off, you need to re-enable the plugin to reconnect)",
        default: true,
    },
    rampUpAndDown: {
        type: OptionType.BOOLEAN,
        description: "If true, it will try and smoothly ramp the vibration intensity up and down",
        default: true,
    },
    rampUpAndDownSteps: {
        type: OptionType.SLIDER,
        description: "How many steps to use when ramping up and down (Default: 20)\nHigher steps will add more delay",
        markers: makeRange(0, 40, 1),
        stickToMarkers: true,
        default: 20,
    },
    websocketUrl: {
        type: OptionType.STRING,
        description: "The URL of the websocket server",
        default: "ws://localhost:12345",
        onChange: () => {
            handleDisconnection();
            handleConnection();
        },
        isValid: (value: string) => {
            if (!value) return "Please enter a URL";
            if (!isValidWebSocketUrl(value)) return "Invalid URL provided. Expected format: ws://127.0.0.1:12345";
            return true;
        },
    },
    maxVibrationIntensity: {
        type: OptionType.SLIDER,
        description: "The maximum intensity of vibration",
        markers: makeRange(0, 100, 10),
        stickToMarkers: false,
        default: 70,
    },
    targetWords: {
        type: OptionType.STRING,
        description: "Comma-separated list of words to use as targets (used for detecting things when you was not mentioned)",
    },
    triggerWords: {
        type: OptionType.STRING,
        description: "Comma-separated list of words to use as triggers",
    },
    addOnWords: {
        type: OptionType.STRING,
        description: "Comma-separated list of words to add to the trigger words (increases vibration per word)",
    },
    switchBlacklistToWhitelist: {
        type: OptionType.BOOLEAN,
        description: "If true, will switch the blacklist to a whitelist",
    },
    listedUsers: {
        type: OptionType.STRING,
        description: "Comma-separated list of user IDs to blacklist/whitelist",
    },
    listedChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of channel IDs to blacklist/whitelist",
    },
    listedGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated list of guild IDs to blacklist/whitelist",
    },
    altOptions: {
        type: OptionType.SELECT,
        description: "Alternative options to use",
        default: "none",
        options: [
            {
                value: "none",
                label: "None (Default)",
            },
            {
                value: "dmOnly",
                label: "DM Only",
            },
            {
                value: "currentChannelOnly",
                label: "Current Channel Only",
            },
            {
                value: "currentGuildOnly",
                label: "Current Guild Only",
            },
        ],
    },
    allowDirectUserControl: {
        type: OptionType.BOOLEAN,
        description: "Allow other users to directly control your toy",
        default: false,
    },
    directControlAllowedUsers: {
        type: OptionType.STRING,
        description: "UserIDs to grant command access to",
    },
    directControlCommandPrefix: {
        type: OptionType.STRING,
        description: "The prefix for the command to be used",
        default: ">.",
        onChange(newValue: string) {
            if (!newValue || newValue === "") {
                pluginSettings.store.directControlCommandPrefix = ">.";
            }
        },
    }
});

export default definePlugin({
    name: "Venplug",
    description: "Detects words in messages and uses them to control a buttplug device",
    authors: [{
        name: "KaydaFox",
        id: 717329527696785408n
    }, {
        name: "danthebitshifter",
        id: 1063920464029818960n
    }],
    settings: pluginSettings,
    async start() {
        if (pluginSettings.store.connectAutomatically)
            await handleConnection();
    },
    stop() {
        handleDisconnection();
    },
    flux: {
        MESSAGE_CREATE: (payload: FluxMessageCreate) => {
            handleMessage(payload.message);
        },
    },
    commands: [
        {
            name: "connect",
            description: "Connect to the intiface server",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_opts, ctx) => {
                if (client && client.connected)
                    return sendBotMessage(ctx.channel.id, { content: "Already connected to intiface" });
                sendBotMessage(ctx.channel.id, { content: "Connecting to intiface..." });
                await handleConnection();
            }
        },
        {
            name: "disconnect",
            description: "Disconnect from the intiface server",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_opts, ctx) => {
                if (client && !client.connected)
                    return sendBotMessage(ctx.channel.id, { content: "You were already disconnected" });
                sendBotMessage(ctx.channel.id, { content: "Disconnecting from intiface..." });
                await handleDisconnection();
            }
        },
        {
            name: "start_scanning",
            description: "Start scanning for devices on the intiface server",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "auto-stop",
                    description: "Auto-stop scanning after 30 seconds (Default: true). if disabled, use /stop_scanning to stop scanning",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false,
                }
            ],
            execute: async (_opts, ctx) => {
                if (!client || !client.connected)
                    return sendBotMessage(ctx.channel.id, { content: "You are not connected to intiface" });

                await client.startScanning();
                const message = sendBotMessage(ctx.channel.id, { content: "Started scanning for devices" });
                if (findOption(_opts, "auto-stop", true) === true)
                    setTimeout(async () => {
                        await client?.stopScanning();
                        editMessage(message, "Finished scanning for devices");
                    }, 30000);



            }
        },
        {
            name: "stop_scanning",
            description: "Stop scanning for devices on the intiface server",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_opts, ctx) => {
                if (!client || !client.connected)
                    return sendBotMessage(ctx.channel.id, { content: "You are not connected to intiface" });
                await client.stopScanning();
                sendBotMessage(ctx.channel.id, { content: "Stopped scanning for devices" });
            }
        },
        {
            name: "words",
            description: "Send all your trigger words",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_opts, ctx) => {
                const triggerWords = pluginSettings.store.triggerWords?.split(",");
                const addOnWords = pluginSettings.store.addOnWords?.split(",");
                const targetWords = pluginSettings.store.targetWords?.split(",");

                sendMessage(ctx.channel.id, { content: `**Target words:** ${targetWords?.join(", ")}\n\n**Trigger words:** ${triggerWords?.join(", ")}\n\n**Add-on words:** ${addOnWords?.join(", ")}` });
            }
        },
        {
            name: "test",
            description: "Test the vibration of all devices",
            options: [
                {
                    name: "intensity",
                    description: "The intensity to use (0 - 100). Default: 30%",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                },
                {
                    name: "duration",
                    description: "The duration to use (uses ms (1000 = 1 second)). Default: 2000",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                }
            ],
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (opts, _ctx) => {
                const intensity = findOption(opts, "intensity", 30);
                const duration = findOption(opts, "duration", 2000);
                await addToVibrateQueue(<VibrateEvent>{ duration, strength: intensity / 100 });
            }
        },
        {
            name: "devices",
            description: "List all connected devices",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "send_to_channel",
                    description: "Send the list to the current channel (Default: false)",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false,
                }
            ],
            execute: async (_opts, ctx) => {
                if (!client || !client.connected)
                    return sendBotMessage(ctx.channel.id, { content: "You are not connected to intiface" });

                const { devices } = client;
                if (devices.length === 0)
                    return sendBotMessage(ctx.channel.id, { content: "No devices connected" });

                const deviceInfo: string[] = [];

                for (let i = 0; i < client.devices.length; i++) {
                    deviceInfo.push(`**Name:** ${client.devices[i].name}, **Battery:** ${client.devices[i].hasBattery ? `${await client.devices[i].battery() * 100}%` : "No battery"}`);
                }

                findOption(_opts, "send_to_channel") ? sendMessage(ctx.channel.id, {
                    content: `**Connected devices:** \n ${deviceInfo.join("\n")}`
                }) : sendBotMessage(ctx.channel.id, {
                    content: `**Connected devices:** \n ${deviceInfo.join("\n")}`
                });
            }
        }
    ]
});

async function handleMessage(message: DiscordMessage) {
    if (message.state && message.state === "SENDING") return;
    if (recentlyHandledMessages.includes(message.id)) {
        return;
    } else {
        recentlyHandledMessages.push(message.id);
        if (recentlyHandledMessages.length > 99) {
            recentlyHandledMessages.shift();
        }
    }

    const currentUser = Vencord.Webpack.Common.UserStore.getCurrentUser();
    let intensity = 0;
    let length = 0;
    let triggered = false;
    let isTargeted = false;

    if (!message.guild_id) console.log(message);

    const listedUsers = pluginSettings.store.listedUsers?.split(",");
    const listedChannels = pluginSettings.store.listedChannels?.split(",");
    const listedGuilds = pluginSettings.store.listedGuilds?.split(",");

    const directControlEnabled: boolean = pluginSettings.store.allowDirectUserControl;
    const directControlUsers: string[] = pluginSettings.store.directControlAllowedUsers?.split(" ") ?? [];
    const { directControlCommandPrefix } = pluginSettings.store;

    const content = message.content.toLowerCase();

    if (directControlEnabled && (message.author.id === currentUser.id || directControlUsers.length > 0) && content.startsWith(directControlCommandPrefix)) {
        const command = content.replace(directControlCommandPrefix, "");
        const commandInfo = command.split(" "); // vibrate 1 20 // vibrate 20

        if (message.author.id !== currentUser.id && !directControlUsers.includes(message.author.id)) return;

        if (!client || !client.connected) {
            return sendMessage(message.channel_id, {
                content: "My client isn't connected right now"
            });
        }

        switch (commandInfo[0]) {
            case "v":
            case "vibrate": {
                if (commandInfo.length < 2 || commandInfo.length > 3) {
                    return sendMessage(message.channel_id, {
                        content: `Incorrect arguments provided. \n**Correct usages**\nAll devices: ${directControlCommandPrefix}vibrate 20\nSpecific device: ${directControlCommandPrefix}vibrate 1 20\narguments: vibrate <deviceId?> <amount>`
                    });
                }

                if (commandInfo.length === 3) {
                    const deviceId = Number(commandInfo[1]);
                    if (isNaN(deviceId) || client.devices.length > deviceId || deviceId < 1) return sendMessage(message.channel_id, {
                        content: "Invalid device ID provided"
                    });

                    let vibrationStrength = Number(commandInfo[2]);
                    if (isNaN(vibrationStrength) || vibrationStrength < 0) return sendMessage(message.channel_id, {
                        content: "Invalid vibration strength"
                    });

                    vibrationStrength > 100 ? vibrationStrength = 100 : vibrationStrength;

                    return client.devices[deviceId - 1].vibrate((vibrationStrength * (pluginSettings.store.maxVibrationIntensity / 100) / 100));
                }

                let vibrationStrength = Number(commandInfo[1]);
                if (isNaN(vibrationStrength) || vibrationStrength < 0) return sendMessage(message.channel_id, {
                    content: "Invalid vibration strength"
                });

                if (vibrationStrength > pluginSettings.store.maxVibrationIntensity) vibrationStrength = pluginSettings.store.maxVibrationIntensity;

                return client.devices.forEach(device => {
                    device.vibrate(vibrationStrength / 100);
                });
            }
            case "durationVibration":
            case "vibrationDuration":
            case "vd":
                if (commandInfo.length < 3 || commandInfo.length > 4) {
                    return sendMessage(message.channel_id, {
                        content: `Incorrect arguments provided. \n**Correct usages**\nAll devices: ${directControlCommandPrefix}vibrate 20 2000\nSpecific device: ${directControlCommandPrefix}vibrate 1 20 2000\narguments: vibrate <deviceId?> <amount> <timeInMilliseconds>`
                    });
                }

                if (commandInfo.length === 4) {
                    const deviceId = Number(commandInfo[1]);
                    if (isNaN(deviceId) || client.devices.length > deviceId || deviceId < 1) return sendMessage(message.channel_id, {
                        content: "Invalid device ID provided"
                    });

                    let vibrationStrength = Number(commandInfo[2]);
                    if (isNaN(vibrationStrength) || vibrationStrength < 0) return sendMessage(message.channel_id, {
                        content: "Invalid vibration strength"
                    });

                    const durationTime = Number(commandInfo[3]);
                    if (isNaN(vibrationStrength) || vibrationStrength < 0) return sendMessage(message.channel_id, {
                        content: "Invalid duration time"
                    });

                    vibrationStrength > 100 ? vibrationStrength = 100 : vibrationStrength;

                    return addToVibrateQueue({ strength: (vibrationStrength * (pluginSettings.store.maxVibrationIntensity / 100) / 100), duration: durationTime, deviceId: deviceId - 1 });
                }

                let vibrationStrength = Number(commandInfo[1]);
                if (isNaN(vibrationStrength) || vibrationStrength < 0) return sendMessage(message.channel_id, {
                    content: "Invalid vibration strength"
                });

                const durationTime = Number(commandInfo[2]);
                if (isNaN(vibrationStrength) || vibrationStrength < 0) return sendMessage(message.channel_id, {
                    content: "Invalid duration time"
                });

                vibrationStrength > 100 ? vibrationStrength = 100 : vibrationStrength;

                return addToVibrateQueue({ strength: (vibrationStrength * (pluginSettings.store.maxVibrationIntensity / 100) / 100), duration: durationTime });

            case "d":
            case "devices": {
                const deviceInfo: string[] = [];

                for (let i = 0; i < client.devices.length; i++) {
                    deviceInfo.push(`**Name:** ${client.devices[i].name}, **ID:** ${i + 1}, **Battery:** ${client.devices[i].hasBattery ? `${await client.devices[i].battery() * 100}%` : "No battery"}`);
                }

                return sendMessage(message.channel_id, {
                    content: `**Connected devices:** \n${deviceInfo.join("\n")}`
                });
            }
        }

        return;
    }

    if (message.author.id === currentUser.id || message.author.bot)
        return;

    const targetWords = pluginSettings.store.targetWords?.toLowerCase().split(",");

    if (message.mentions?.some(mention => mention.id === currentUser.id) || content.includes(currentUser.username) || message.referenced_message?.author.id === currentUser.id || !message.guild_id || targetWords?.some(targetWord => content.includes(targetWord)))
        isTargeted = true;

    if (!isTargeted)
        return;

    if (pluginSettings.store.altOptions === "dmOnly" && message.guild_id)
        return;
    else if (pluginSettings.store.altOptions === "currentChannelOnly" && message.channel_id !== getCurrentChannel().id)
        return;
    else if (pluginSettings.store.altOptions === "currentGuildOnly" && (!message.guild_id || message.guild_id !== getCurrentGuild()?.id))
        return;

    // L this is such a mess :P (someone help me >.<)

    const isUserListed = listedUsers?.includes(message.author.id);
    const isChannelListed = listedChannels?.includes(message.channel_id);
    const isGuildListed = message.guild_id && listedGuilds?.includes(message.guild_id);

    const shouldIncludeMessage = pluginSettings.store.switchBlacklistToWhitelist
        ? isUserListed || isChannelListed || isGuildListed
        : !isUserListed && !isChannelListed && !isGuildListed;

    if (!shouldIncludeMessage)
        return;

    const triggerWords = pluginSettings.store.triggerWords?.toLowerCase().split(",");
    if (!triggerWords)
        return;

    const addOnWords = pluginSettings.store.addOnWords?.toLowerCase().split(",");

    triggerWords.forEach(triggerWord => {
        if (content.includes(triggerWord)) {
            triggered = true;
            intensity += 19;
            length += 2000;
        }
    });

    if (triggered) {
        addOnWords && addOnWords.forEach(addOnWord => {
            if (content.includes(addOnWord)) {
                intensity += 7.5;
                length += Math.floor(Math.random() * (30 - 5 + 1) + 5);
            }
        });

        if (!message.guild_id) {
            intensity *= 1.35;
            length *= 2;
        }

        if (pluginSettings.store.rampUpAndDown)
            length += 1250;

        intensity > 100 ? intensity = 100 : intensity;
        addToVibrateQueue({ strength: (intensity * (pluginSettings.store.maxVibrationIntensity / 100) / 100), duration: length });
    }
}

async function handleDisconnection() {
    try {
        vibrateQueue = [];
        if (client && client.connected) await client.disconnect();
        client = null;
        if (batteryIntervalId) clearInterval(batteryIntervalId);

        showNotification({
            title: "Disconnected from intiface",
            body: "You are now disconnected from intiface",
            permanent: false,
            noPersist: false,
        });
    } catch (error) {
        console.error(error);
    }
}


export function editMessage(message: PartialDeep<Message>, content: string): Message {
    message.content = content;
    FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message });
    return message as Message;
}

async function handleConnection() {
    try {
        if (!pluginSettings.store.websocketUrl) {
            return showNotification({
                title: "No URL provided for intiface",
                body: "Please provide a URL in the settings, connecting to intiface disabled",
                permanent: false,
                noPersist: false,
            });
        }

        connector = new ButtplugBrowserWebsocketClientConnector(pluginSettings.store.websocketUrl);
        if (!client)
            client = new ButtplugClient("Vencord");

        client.addListener("deviceadded", async (device: ButtplugClientDevice) => {
            device.warnedLowBattery = false;

            showNotification({
                title: `Device added (Total devices: ${client?.devices.length})`,
                body: `A device named "${device.name}" was added ${device.hasBattery && `and has a battery level of ${await device.battery() * 100}%`}`,
                permanent: false,
                noPersist: false,
            });

            if (device.vibrateAttributes.length === 0)
                return;

            try {
                await device.vibrate(0.1);
                await new Promise(r => setTimeout(r, 500));
                await device.stop();
            } catch (error) {
                console.log(error);
                if (error instanceof ButtplugDeviceError) {
                    console.log("got a device error!");
                }
            }
        });

        client.addListener("deviceremoved", (device: ButtplugClientDevice) => {
            showNotification({
                title: "Device removed",
                body: `A device named "${device.name}" was removed`,
                permanent: false,
                noPersist: false,
            });
        });

        await client.connect(connector).then(() => console.log("Buttplug.io connected"));

        checkDeviceBattery();

        showNotification({
            title: "Connected to intiface",
            body: "You are now connected to intiface",
            permanent: false,
            noPersist: false,
        });
    } catch (error) {
        console.error(error);
        showNotification({
            title: "Failed to connect to intiface",
            body: "Failed to connect to intiface, please check the console for more information",
            permanent: false,
            noPersist: false,
        });
    }
}

async function checkDeviceBattery() {
    if (!client) return;
    batteryIntervalId = setInterval(async () => {
        client!.devices.forEach(async (device: ButtplugClientDevice) => {
            if (device.hasBattery && !device.warnedLowBattery) {
                const battery = await device.battery();
                if (battery < 0.1) {
                    device.warnedLowBattery = true;
                    showNotification({
                        title: "Device battery low",
                        body: `The battery of device "${device.name}" is low (${battery * 100}%)`,
                        permanent: false,
                        noPersist: false,
                    });
                }
            }
        });
    }, 60000); // 1 minute
}

async function addToVibrateQueue(data: VibrateEvent) {
    vibrateQueue.push(data);
    if (vibrateQueue.length === 1) {
        processVibrateQueue();
    }
}

async function processVibrateQueue() {
    if (vibrateQueue.length === 0) {
        return;
    }

    const data = vibrateQueue[0];

    try {
        await handleVibrate(data);
    } catch (error) {
        console.error("Error in handleVibrate:", error);
    } finally {
        vibrateQueue.shift();

        processVibrateQueue();
    }
}


async function handleVibrate(data: VibrateEvent) {
    if (!client || !client.devices) {
        return;
    }

    const devices = data.deviceId ? [client.devices[data.deviceId]] : client.devices;
    if (!pluginSettings.store.rampUpAndDown) {
        await vibrateDevices(devices, data.strength);
        await sleep(data.duration);
        stopDevices(devices);
    } else {
        const steps = pluginSettings.store.rampUpAndDownSteps;
        const rampLength = data.duration * 0.2 / steps;
        let startIntensity = 0;
        let endIntensity = data.strength;
        let stepIntensity = (endIntensity - startIntensity) / steps;

        for (let i = 0; i <= steps; i++) {
            await vibrateDevices(devices, startIntensity + (stepIntensity * i));
            await sleep(rampLength);
        }

        await sleep(data.duration * 0.54);

        startIntensity = data.strength;
        endIntensity = 0;

        stepIntensity = (endIntensity - startIntensity) / steps;

        for (let i = 0; i <= steps; i++) {
            await vibrateDevices(devices, startIntensity + (stepIntensity * i));
            await sleep(rampLength);
        }
        stopDevices(devices);
    }
}
async function stopDevices(devices: ButtplugClientDevice[]) {
    for (const device of devices) {
        await device.stop();
    }

}
async function vibrateDevices(devices: ButtplugClientDevice[], intensity: number) {
    if (intensity > 1) intensity = 1;
    if (intensity < 0) intensity = 0;
    for (const device of devices) {
        await device.vibrate(intensity);
    }
}

interface FluxMessageCreate {
    type: "MESSAGE_CREATE";
    channelId: string;
    guildId?: string;
    isPushNotification: boolean;
    message: DiscordMessage;
    optimistic: boolean;
}

interface DiscordMessage {
    content: string;
    mentions?: DiscordUser[];
    member: DiscordUser;
    message_reference?: {
        channel_id: string;
        guild_id: string;
        message_id: string;
    };
    referenced_message?: DiscordMessage;
    author: DiscordUser;
    guild_id?: string;
    channel_id: string;
    id: string;
    type: number;
    channel: {
        id: string;
    };
    state?: string;
}

interface DiscordUser {
    avatar: string;
    username: string;
    id: string;
    bot: boolean;
}

declare module "buttplug" {
    interface ButtplugClientDevice {
        warnedLowBattery: boolean;
    }
}

type VibrateEvent = {
    duration: number,
    strength: number,
    deviceId?: number;
};
