/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Needed header for all plugins

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { makeRange } from "@components/PluginSettings/components";
import { getCurrentChannel, getCurrentGuild, sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { ButtplugBrowserWebsocketClientConnector, ButtplugClient, ButtplugClientDevice, ButtplugDeviceError } from "buttplug";

function isValidWebSocketUrl(url: string): boolean {
    // Regular expression for WebSocket URL validation
    const webSocketUrlPattern = /^wss?:\/\/[^\s/$.?#].[^\s]*$/;

    // Test the URL against the pattern
    return webSocketUrlPattern.test(url);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let client: ButtplugClient | null = null;
let connector: ButtplugBrowserWebsocketClientConnector;

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
    }
});

export default definePlugin({
    name: "Venplug",
    description: "Detects words in messages and uses them to control a buttplug device",
    authors: [{
        name: "KaydaFox",
        id: 717329527696785408n
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
            handeMessage(payload.message);
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
                await handleVibrate(intensity / 100, duration);
            }
        },
    ]
});

async function handeMessage(message: DiscordMessage) {
    const currentUser = Vencord.Webpack.Common.UserStore.getCurrentUser();
    let intensity = 0;
    let length = 0;
    let triggered = false;
    let isTargeted = false;

    const listedUsers = pluginSettings.store.listedUsers?.split(",");
    const listedChannels = pluginSettings.store.listedChannels?.split(",");
    const listedGuilds = pluginSettings.store.listedGuilds?.split(",");

    if (message.author.id === currentUser.id || message.author.bot || message.author.id !== "1063920464029818960")
        return;

    const content = message.content.toLowerCase();
    const targetWords = pluginSettings.store.targetWords?.toLowerCase().split(",");

    if (message.mentions?.some(mention => mention.id === currentUser.id) || message.content.includes(currentUser.username) || message.referenced_message?.author.id === currentUser.id || !message.guild_id || targetWords?.some(targetWord => content.includes(targetWord)))
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
        handleVibrate((intensity * (pluginSettings.store.maxVibrationIntensity / 100) / 100), length);
    }
}

async function handleDisconnection() {
    if (client && client.connected) client.disconnect();
}

async function handleConnection() {
    try {
        if (!pluginSettings.store.websocketUrl) {
            console.log("no url provided, not attempting to connect");
            return;
        }

        connector = new ButtplugBrowserWebsocketClientConnector(pluginSettings.store.websocketUrl);
        if (!client)
            client = new ButtplugClient("Vencord");

        client.addListener("deviceadded", async device => {
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

        await client.connect(connector).then(() => console.log("Buttplug.io connected"));
    } catch (error) {
        console.error(error);
    }
}

async function handleVibrate(intensity: number, length: number) {
    client?.devices.forEach(async device => {
        if (!pluginSettings.store.rampUpAndDown) {
            await device.vibrate(intensity);
            await sleep(length);
            await device.stop();
        } else {
            const steps = pluginSettings.store.rampUpAndDownSteps;
            const rampLength = length * 0.2 / steps;
            let startIntensity = 0;
            let endIntensity = intensity;
            let stepIntensity = (endIntensity - startIntensity) / steps;

            for (let i = 0; i <= steps; i++) {
                await vibrateDevices(device, startIntensity + (stepIntensity * i));
                await sleep(rampLength);
            }

            await sleep(length * 0.54);

            startIntensity = intensity;
            endIntensity = 0;

            stepIntensity = (endIntensity - startIntensity) / steps;

            for (let i = 0; i <= steps; i++) {
                await vibrateDevices(device, startIntensity + (stepIntensity * i));
                await sleep(rampLength);
            }

            await device.stop();
        }
    });
}

async function vibrateDevices(device: ButtplugClientDevice, intensity: number) {
    if (intensity > 1) intensity = 1;
    if (intensity < 0) intensity = 0;
    await device.vibrate(intensity);
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
}

interface DiscordUser {
    avatar: string;
    username: string;
    id: string;
    bot: boolean;
}
