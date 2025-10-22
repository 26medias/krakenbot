const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

class GPT5 {
    constructor(model) {
        this.model = model;
        this.baseURL = 'https://api.openai.com/v1';
    }

    async chat(systemPrompt, prompt, max_completion_tokens=null, history=[], reasoning='minimal', verbosity='medium') {
        const messages = [
            {
                role: 'system',
                content: systemPrompt
            },
            ...history,
            {
                role: 'user',
                content: prompt
            }
        ];

        let params = {
            model: this.model,
            messages,
            reasoning: {
                effort: reasoning
            },
            text: {
                verbosity
            }
        };
        if (max_completion_tokens) {
            params.max_output_tokens = max_completion_tokens;
        }

        const response = await this.api('/chat/completions', params);
        return response;
    }

    async attachmentsFromFiles(files) {
        /*
            Return [
                {
                    "type": "input_file",
                    "filename": "draconomicon.pdf",
                    "file_data": "...base64 encoded PDF bytes here..."
                },
                ...
            ]
        */
        let attachmentObjects = [];
        for (let file of files) {
            let attachment = {
                filename: file.name
            };
            
            // Check if file is binary or text based on mime type or extension
            const isBinary = file.type && (
                file.type.startsWith('image/') ||
                file.type === 'application/pdf' ||
                file.type.startsWith('video/') ||
                file.type.startsWith('audio/')
            );
            
            if (isBinary) {
                // For binary files, read as base64
                const buffer = await file.arrayBuffer();
                const base64 = Buffer.from(buffer).toString('base64');
                attachment.file_data = base64;
            } else {
                // For text files, read as text
                const text = await file.text();
                attachment.file_data = text;
            }
            
            attachmentObjects.push(attachment);
        }
        return attachmentObjects;       
    }

    async ask(prompt, max_completion_tokens=null, reasoning='minimal', verbosity='medium', attachments=[]) {
        //console.log("ask()", prompt)
        let params = {
            model: this.model,
            //input: prompt,
            reasoning: {
                effort: reasoning
            },
            text: {
                verbosity
            }
        };
        if (!attachments || attachments.length==0) {
            params.input = prompt;
        } else {
            params.input = {
                role: "user",
                content: [
                    ...attachments,
                    {
                        type: "input_text",
                        text: prompt
                    }
                ]
            }
        }
        if (max_completion_tokens) {
            params.max_output_tokens = max_completion_tokens;
        }
        const response = await this.api('/responses', params);

        const messageResponse = response.output.find(item => item.type=='message');
        //console.log(messageResponse)

        //console.log(">>>", messageResponse)
        const cleanResponse = this.cleanupResponse(messageResponse.content[0].text);
        console.log(">>>", cleanResponse)
        return {
            response: cleanResponse,
            usage: response.usage
        };
    }

    cleanupResponse(input) {
        try {
            if (input.substr(0, 3) == '```') {
                // remove the "```{language}\n" using regex at the start & the "```" at the end
                input = input.replace(/^```[a-z]*\n/, '').replace(/```$/, '');            
            }
        } catch(e) {
            console.log("Error on cleanupResponse()", e.message, {input})
        }

        try {
            input = JSON.parse(input);
        } catch (e) {}

        
        return input;
    }

    async api(endpoint, params) {
        let resp;
        try {
            resp = await axios.post(
                `${this.baseURL}${endpoint}`,
                params,
                {
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                    }
                }
            );
        } catch (e) {
            console.log("Axios error")
            if (e.response) {
                console.error(`Error response from server: ${e.response.status} ${e.response.statusText}`);
                console.error(`Response data: ${JSON.stringify(e.response.data, null, 2)}`);
            } else {
                console.error(e.message, e.stack);
            }
        }
        return resp.data;
    }

    getPrompt(promptFilename, data = {}) {
        // Turn the initial promptFilename into an absolute path:
        const entryPath = path.resolve(promptFilename);
        const visited   = new Set();

        /**
         * Recursively load and expand a file at `currentPath`.
         * Strips includes of the form [[other.txt]] relative to its directory.
         */
        const loadFile = (currentPath) => {
            if (visited.has(currentPath)) {
                throw new Error(`Circular include detected: ${currentPath}`);
            }
            visited.add(currentPath);

            let content = fs.readFileSync(currentPath, 'utf8');

            // Resolve every [[includeFilename]] → loadFile(includePath)
            content = content.replace(/\[\[([^\]]+)\]\]/g, (_, incFilename) => {
                const parentDir   = path.dirname(currentPath);
                const includePath = path.resolve(parentDir, incFilename);
                return loadFile(includePath);
            });

            return content;
        };

        // Load the root file (with includes expanded):
        let fullContent = loadFile(entryPath);

        // Interpolate {varname} → data[varname] || ''
        fullContent = fullContent.replace(/\{(\w+)\}/g, (_, key) => {
            return data[key] !== undefined ? data[key] : '';
        });

        return fullContent;
    }
}

module.exports = GPT5;

