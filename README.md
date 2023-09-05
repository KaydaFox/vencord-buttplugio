# What is this?

I- a boredom project lol. The idea came from a friend and i was just kinda like "Hm... I'm bored, why not?" and then this was born
Its purpose is to let you control toys compatible with buttplug.io via words on discord.

E.g. when someone calls me a "good girl", it will vibrate for a few seconds at 20% intensity.

Is the code here the best? Absolutely not, but I was bored and wanted to make something for fun.

I may need to add more information here later, but for now, this is it.

# How to use?

To use this plugin, you NEED your own local copy of vencord. You can get it [here](https://github.com/vendicated/vencord).
Once you clone that, place this plugin into a folder called "userplugins" inside of "src".
Make sure to install "buttplug" (`pnpm install && pnpm install buttplug`).
You now want to inject this into discord with `pnpm build` and then `pnpm inject`, then select your discord version.

Now, when you launch discord, you can go to settings > vencord > plugins and enable this plugin.
The plugin has some settings that you can change, like the websocket for intiface and the words that will trigger vibrations

Trigger words are the main words that are detected, if none are detected then nothing will happen
When a trigger word is detected, the plugin will search for addon words, these increase the intensity and length of the vibration
If no addon words are detected, then the default intensity and length for the trigger words will be used

Target words are words that will be detected no matter what, since the plugin limits the usual words to DMs or when you are pinged.

As an example, if someone just puts "Kayda is a good girl" in a channel, the plugin will detect this and then follow through with the trigger words (being "good girl" in this case).
