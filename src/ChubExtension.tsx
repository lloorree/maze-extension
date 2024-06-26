import {ReactElement} from "react";
import {AspectRatio, Extension, ExtensionResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import SquareMaze, {generateMaze} from "./SquareMaze.tsx";
import {deserializeVisited} from "./solver.ts";
import {canMove, deserializeMazeCell, MazeGrid, MazeWall} from "./maze.ts";

type MessageStateType = {userLocation: { posX: number, posY: number, facingX: number, facingY: number }, image: string};

type ConfigType = { size?: number | null, imagePromptPrefix?: string | null };

type ChatStateType = {
    visited: {[key: number]: Set<number>}
}

type InitStateType = {
    maze: MazeGrid
};

export class ChubExtension extends Extension<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    userLocation: { posX: number, posY: number, facingX: number, facingY: number };
    maze: MazeGrid
    mazeId: string
    size: number
    imagePromptPrefix: string
    image: string
    visited: {[key: number]: Set<number>}
    quit: boolean

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
            config,
            messageState,
            chatState,
            initState
        } = data;
        this.quit = false;
        this.size = config != null && config.hasOwnProperty('size') && config.size != null ? config.size : 15;
        if(initState != null && initState.hasOwnProperty('maze') && initState.maze != null) {
            this.maze = initState.maze
            this.size = this.maze.length;
            this.maze.forEach(row => {
                row.forEach(col => {
                    // An example of a common serde issue, when an enum is used as a key instead of "normal"
                    // string and field names.
                    col.walls = deserializeMazeCell(col).walls;
                })
            })
        } else {
            this.maze = generateMaze(this.size, this.size);
        }
        if(config != null && config.hasOwnProperty('imagePromptPrefix') && config.imagePromptPrefix != null) {
            this.imagePromptPrefix = config.imagePromptPrefix;
        } else {
            this.imagePromptPrefix = 'Highest quality, 8K, digital art, ';
        }
        this.mazeId = Object.keys(characters).filter(charId => characters[charId].name == 'The Maze')[0];
        if(messageState != null) {
            this.userLocation = messageState.userLocation;
            this.image = messageState.image;
        } else {
            const middle = Math.floor(this.size / 2);
            this.userLocation = {posX: middle, posY: middle, facingX: 0, facingY: 1};
            this.image = '';
        }
        // The strange serde here is because JSON doesn't allow numbers as keys.
        this.visited = chatState != null ? deserializeVisited(chatState.visited) : {};
        this.visit();
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        return {
            success: true,
            error: null,
            initState: { maze: this.maze },
            messageState: {userLocation: {...this.userLocation}, image: this.image},
            chatState: {visited: this.visited},
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        if (state != null) {
            this.userLocation = {...this.userLocation, ...state.userLocation};
            this.image = state.image;
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<ExtensionResponse<ChatStateType, MessageStateType>>> {
        const {
            content,
            anonymizedId,
            isBot,
            promptForId
        } = userMessage;
        let moved = false;
        const lowerString = content.toLowerCase();
        Object.values(MazeWall).forEach(wall => {
            if(lowerString.includes(wall)) {
                const wallEnum = MazeWall[wall as keyof typeof MazeWall];
                while(canMove(wallEnum, this.maze[this.userLocation.posX][this.userLocation.posY], moved, this.userLocation, this.size)) {
                    switch (wallEnum) {
                        case MazeWall.right:
                            this.userLocation.posY += 1;
                            break;
                        case MazeWall.left:
                            this.userLocation.posY -= 1;
                            break;
                        case MazeWall.up:
                            this.userLocation.posX -= 1;
                            break;
                        case MazeWall.down:
                            this.userLocation.posX += 1;
                            break;
                        default:
                            break;
                    }
                    moved = true;
                    this.visit();
                }
            }
        });
        if (lowerString.includes('quit')) {
            this.quit = true;
        } else if (lowerString.includes('retry')) {
            this.quit = false;
        }
        let modifiedMessage = null;
        let extensionMessage = null;
        if(this.won()) {
            extensionMessage = "-- Important System Note: the player(s) have reached the exit of The Maze! Game Won! --";
        } else if (this.quit) {
            extensionMessage = "-- Important System Note: the player(s) have given up and quit. The way out is now revealed to them, but they have lost forever. --";
        }
        return {
            extensionMessage,
            messageState: {userLocation: {...this.userLocation}, image: this.image},
            chatState: {visited: this.visited},
            modifiedMessage,
            error: null
        };
    }

    won() {
        return this.userLocation.posX == 0 || this.userLocation.posY == 0 || this.userLocation.posY == this.size - 1 || this.userLocation.posX == this.size - 1;
    }

    async afterResponse(botMessage: Message): Promise<Partial<ExtensionResponse<ChatStateType, MessageStateType>>> {
        const {
            content,
            anonymizedId,
            isBot
        } = botMessage;
        let modifiedMessage = null;
        let systemMessage = "";
        if(anonymizedId == this.mazeId) {
            if(content.includes('```')) {
                modifiedMessage = content.substring(0, content.indexOf('```'));
            }
            let prompt = this.imagePromptPrefix;
            if (modifiedMessage != null) {
                prompt += modifiedMessage
            } else {
                prompt += content;
            }
            if(content.includes('<')) {
                let end = content.length;
                if(content.includes('>')) {
                    end = content.indexOf('>');
                    modifiedMessage = modifiedMessage != null ? modifiedMessage.substring(0, end+1) : content.substring(0, end + 1);
                }
                prompt = content.substring(content.indexOf('<') + 1, end);
            }
            this.generator.makeImage({aspect_ratio: AspectRatio.SQUARE,
                negative_prompt: "", prompt: this.imagePromptPrefix + prompt,
                seed: 0}).then(image => {
                this.image = image != null ? image.url : '';
            });
            let avail = [];
            if(this.userLocation.posX == 0 || this.userLocation.posY == 0 || this.userLocation.posX >= this.maze.length - 1 || this.userLocation.posY >= this.maze[0].length - 1) {
                systemMessage = "```\nMaze Complete.\n```"
            } else {
                systemMessage = "```\nAvailable Directions:\n";
                const current = this.maze[this.userLocation.posX][this.userLocation.posY];
                if(!current.walls[MazeWall.up]) {
                    avail.push('up');
                }
                if(!current.walls[MazeWall.down]) {
                    avail.push('down');
                }
                if(!current.walls[MazeWall.left]) {
                    avail.push('left');
                }
                if(!current.walls[MazeWall.right]) {
                    avail.push('right');
                }
                if(!this.quit) {
                    avail.push('quit');
                } else {
                    avail.push('retry');
                }
                systemMessage += `[ ${avail.join(', ')} ]`;
                systemMessage += "\n```";
            }
        }
        return {
            extensionMessage: null,
            messageState: {userLocation: {...this.userLocation}, image: this.image},
            chatState: {visited: this.visited},
            modifiedMessage,
            systemMessage,
            error: null
        };



    }

    visit() {
        for (let r = -1; r < 2; r++) {
            for (let c = -1; c < 2; c++) {
                if (this.userLocation.posX + r < 0 || this.userLocation.posY + c < 0 || this.userLocation.posX + r >= this.maze.length || this.userLocation.posY + c >= this.maze[0].length) {
                    continue;
                }
                this.maze[this.userLocation.posX + r][this.userLocation.posY + c].visited = true;
                if (!this.visited[this.userLocation.posX + r]) {
                    this.visited[this.userLocation.posX + r] = new Set();
                }
                this.visited[this.userLocation.posX + r].add(this.userLocation.posY + c);
            }
        }
    }


    render(): ReactElement {
        return <>
            <SquareMaze grid={this.maze} userLocation={this.userLocation} quit={this.quit || this.won()} />
            {this.image != null && this.image != '' && <img src={this.image} />}
        </>
    }

}
