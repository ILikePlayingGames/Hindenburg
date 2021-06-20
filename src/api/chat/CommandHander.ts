import chalk from "chalk";

import { MessageSide, Player, Room } from "../../room";
import { Worker } from "../../Worker";

function betterSplitOnSpaces(input: string) {
    let collector = "";
    let output = [];
    let in_string = false;
    for (const char of input) {
        if (char === "'") {
            in_string = !in_string;
        } else if (char === " " && !in_string) {
            output.push(collector);
            collector = "";
        } else {
            collector += char;
        }
    }
    if (collector)
        output.push(collector);

    return output;
}

export interface ChatCommandParameter {
    isRest: boolean;
    required: boolean;
    name: string;
}

export class CallError extends Error {};
export class ChatCommandContext {
    constructor(
        /**
         * The room that this command came from.
         */
        public readonly room: Room,
        /**
         * The player that sent the message calling the command.
         */
        public readonly player: Player,
        /**
         * The original message that the player sent (without the leading '/').
         */
        public readonly message: string
    ) {}

    /**
     * Reply to the message that called this command.
     * @summary Calls {@link Room.sendChat}
     * @param message The message to reply with.
     */
    async reply(message: string) {
        await this.room.sendChat(message, {
            side: MessageSide.Left,
            target: this.player
        });
    }
}

export type ChatCommandCallback = (ctx: ChatCommandContext, args: any) => any;

export class RegisteredChatCommand {
    constructor(
        public readonly name: string,
        public readonly params: ChatCommandParameter[],
        public readonly description: string,
        public readonly callback: ChatCommandCallback
    ) {}

    static parse(usage: string, description: string, callback: ChatCommandCallback) {
        // https://github.com/dthree/vorpal/blob/51f5e2b545631b6a86c9781c274a1b0916a67ee8/lib/vorpal.js#L311
        const matchedParams = usage.match(/(\[[^\]]*\]|\<[^\>]*\>)/g) || [];
        const matchedCmdName = usage.match(/^([^\[\<]*)/g)?.[0]?.trim() || "";

        if (!matchedCmdName)
            throw new TypeError("Invalid command name.");

        if (matchedCmdName.includes("  "))
            throw new TypeError("Command name cannot contain spaces.");

        const cmdParams: ChatCommandParameter[] = [];

        let wasOptional = false; // Flag to prevent required parameters from coming after optional ones
        for (let i = 0; i < matchedParams.length; i++) {
            let matchedParam = matchedParams[i];
            const param: ChatCommandParameter = {
                isRest: false,
                required: false,
                name: ""
            };
            if (matchedParam.startsWith("[")) {
                wasOptional = true;
            }
            if (matchedParam.startsWith("<")) {
                if (wasOptional) { // Check if an optional parameter has come before
                    throw new TypeError("Required parameter cannot come after an optional parameter.");
                }
                param.required = true;
            }
            matchedParam = matchedParam.substr(1, matchedParam.length - 2); // Remove surrounding parameter markers, [ ] and < >
            if (matchedParam.endsWith("...")) {
                param.isRest = true;
                matchedParam = matchedParam.substr(0, matchedParam.length - 3); // Remove trailing ...
                if (i !== matchedParams.length - 1) {
                    throw new TypeError("Rest parameter must be last.");
                }
            }
            param.name = matchedParam;
            cmdParams.push(param);
        }

        const chatCommand = new RegisteredChatCommand(matchedCmdName, cmdParams, description, callback);
        return chatCommand;
    }

    /**
     * Create a formatted usage of this command, in [standard unix command-line
     * command syntax](https://en.wikipedia.org/wiki/Command-line_interface#Command_description_syntax).
     */
    createUsage() {
        return "/" + this.name + " " + this.params.map(param => {
            return (param.required ? "<" : "[")
                + param.name
                + (param.required ? ">" : "]");
        }).join(" ");
    }

    /**
     * Verify that an array of arguments correctly fits the usage of this command.
     * @param args The arguments to verify.
     * @returns The arguments mapped from parameter name to value of the argument
     * passed.
     */
    verify(args: string[]): Record<string, string> {
        const argsCloned = [...args]; // Clone the array to not affect the original arguments array
        const parsed: Record<string, string> = {};

        for (const param of this.params) {
            const consume = param.isRest
                ? argsCloned.join(" ")
                : argsCloned.shift();

            if (!consume) {
                if (param.required) {
                    throw new CallError("Usage: <color=#12a50a>" + this.createUsage() + "</color>\n\<color=#f7584e>Missing: " + param.name + "</color>\n\n" + this.description);
                }
                return parsed; // No more arguments are left to consume
            }

            parsed[param.name] = consume;
        }

        return parsed;
    }
}

export class ChatCommandHandler {
    commands: Map<string, RegisteredChatCommand>;

    constructor(
        public readonly worker: Worker
    ) {
        this.commands = new Map;

        this.worker.on("player.chat", async ev => {
            if (ev.message.startsWith("/")) {
                ev.rpc.cancel(); // Prevent message from being broadcasted
                const restMessage = ev.message.substr(1);
                const context = new ChatCommandContext(ev.room, ev.player, ev.message);
                try {
                    await this.parseMessage(context, restMessage);
                } catch (e) {
                    if (e instanceof CallError) {
                        await context.reply(e.message);
                    } else {
                        this.worker.logger.error("Error while executing command %s: %s",
                            ev.message, e);
                    }
                }
            }
        });

        this.registerCommand("help [command]", "Get a list of commands and how to use them, or get help for a specific command.", async (ctx, args) => {
            if (args.command) {
                const command = this.commands.get(args.command);

                if (!command) {
                    await ctx.reply("No command with name: " + args.command);
                    return;
                }

                await ctx.reply("Usage: <color=#12a50a>" + command.createUsage() + "</color>\n\n" + command.description);
                return;
            }
            
            let outMessage = "Listing " + this.commands.size + " command(s):";
            for (const [ , command ] of this.commands) {
                outMessage += "\n\n<space=1em><color=#12a50a>" + command.createUsage() + "</color> - " + command.description;
            }
            await ctx.reply(outMessage);
        });
    }

    /**
     * Register a command into the command handler.
     * @param usage How to use the command in [standard unix command-line command
     * syntax](https://en.wikipedia.org/wiki/Command-line_interface#Command_description_syntax).
     * @param description A short summary of what the command does, how to use it, etc.
     * @param callback A callback function for when the command is called.
     * @returns The command that was parsed.
     * @example
     * ```ts
     * worker.chatCommandHandler.parseMessage("ping", "Ping the server.", (ctx, args) => {
     *   ctx.reply("pong!");
     * });
     * ```
     */
    registerCommand(usage: string, description: string, callback: ChatCommandCallback) {
        const parsedCommand = RegisteredChatCommand.parse(usage, description, callback);
        this.commands.set(parsedCommand.name, parsedCommand);
        this.worker.logger.info("Registered chat command: '%s'", parsedCommand.name);
        return parsedCommand;
    }

    /**
     * Remove a command from the command handler.
     * @param commandName The name of the command to be removed, should be {@link RegisteredChatCommand.name}.
     * ```ts
     * worker.chatCommandHandler.removeCommand("ping");
     * ```
     */
    removeCommand(commandName: string) {
        if (!this.commands.has(commandName))
            throw new TypeError("No command: " + commandName);

        this.commands.delete(commandName);
        this.worker.logger.info("Command unregistered: '%s'", commandName);
    }

    /**
     * Parse a message calling a command. Does not trim off a leading '/'.
     * @param ctx Context for the message.
     * @param message The message to parse.
     * @example
     * ```ts
     * const message = "setname weakeyes";
     * const ctx = new ChatCommandContext(room, room.players.host, message);
     * 
     * await worker.chatCommandHandler.parseMessage(ctx, message);
     * ```
     */
    async parseMessage(ctx: ChatCommandContext, message: string) {
        const args = betterSplitOnSpaces(message);
        const commandName = args.shift();

        if (!commandName)
            throw new CallError("Bad command call.");

        const command = this.commands.get(commandName);

        if (!command)
            throw new CallError("No command with name: " + commandName);

        const parsed = command.verify(args);

        await command.callback(ctx, parsed);
    }
}