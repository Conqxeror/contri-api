const express = require('express');
const fs = require('fs/promises');
const { execSync } = require('child_process');
const markdownPdf = require('markdown-pdf');
const axios = require('axios');
const cors = require('cors');
const child_process = require('child_process');
require('dotenv').config();

const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT;
const API_KEY = process.env.YOUR_API_KEY;
const MODEL_NAME = "gemini-1.0-pro";

let cloneProcess = null; // Variable to store the cloning process

async function runChat(inputData) {
    console.log("AI Process");
    console.log(inputData);
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const generationConfig = {
        temperature: 0.9,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
    };

    const safetySettings = [
        {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
    ];

    const chat = model.startChat({
        generationConfig,
        safetySettings,
        history: [],
    });

    const result = await chat.sendMessage(inputData);
    const response = result.response;
    console.log(response.text());
    return response.text();
}

// Define a new API endpoint to handle user requests for code changes
app.post('/code-changes', async (req, res) => {
    const { mdxContent, issues, userRequest } = req.body;
    console.log(req.body);

    try {
        // Prepare input data for the AI model
        const inputData = `You are a software developer. Below is the Code, issues and User request to make changes. Make sure to make changes in the code given according to the issue given by fixing the issue: \n\n\n ${mdxContent}\n\nIssues:\n${JSON.stringify(issues)}\n\nUser Request: ${userRequest}`;

        // Call the AI model to get a response
        const response = await runChat(inputData);

        // Send the response back to the user
        res.json({ response });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Function to recursively traverse directory and generate MDX content
async function traverseDirectory(dir, mdxContent, pdfContent) {
    const files = await fs.readdir(dir);
    for (const file of files) {
        const filePath = `${dir}/${file}`;
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            const hasCodeFiles = (await fs.readdir(filePath)).some(fileName => ['.js', '.jsx', '.ts', '.tsx', '.py', '.css', '.json', '.sh'].some(ext => fileName.endsWith(ext)));
            if (hasCodeFiles) {
                mdxContent += `## ${filePath}\n\n`;
                pdfContent += `## ${filePath}\n\n`;
                const { mdxContent: nestedMdxContent, pdfContent: nestedPdfContent } = await traverseDirectory(filePath, '', '');
                mdxContent += nestedMdxContent;
                pdfContent += nestedPdfContent;
            }
        } else if (file !== '.gitignore' && file !== 'package-lock.json') {
            const fileExtension = file.split('.').pop().toLowerCase();
            if (!['jpg', 'jpeg', 'png', 'gif', 'ico', 'md'].includes(fileExtension)) {
                const fileContent = (await fs.readFile(filePath, 'utf8')).replace(/\r?\n|\r/g, '');
                mdxContent += `\`${filePath}\`\n\n\`\`\`javascript\n${fileContent}\n\`\`\`\n\n`;
                pdfContent += `File Path: ${filePath}\n\nCode:\n\n${fileContent}\n\n`;
            }
        }
    }
    return { mdxContent, pdfContent };
}

// Function to fetch issues from GitHub API
async function fetchIssues(repoOwner, repoName) {
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/issues`;
    try {
        const response = await axios.get(apiUrl);
        return response.data;
    } catch (error) {
        console.error('Error fetching issues:', error.message);
        return [];
    }
}

// API endpoint to generate files
app.post('/generate-files', async (req, res) => {
    const { repoOwner, repoName } = req.body;

    try {
        // Clone the repository
        execSync(`git clone https://github.com/${repoOwner}/${repoName}`);

        // Generate MDX and PDF files
        const mdxContent = '# Repository Code\n\n';
        let pdfContent = '';

        const { mdxContent: finalMdxContent, pdfContent: finalPdfContent } = await traverseDirectory(repoName, mdxContent, pdfContent);

        // Save MDX file
        await fs.writeFile(`${repoName}.mdx`, finalMdxContent);

        // Save PDF file
        await markdownPdf().from.string(finalPdfContent).to(`${repoName}.pdf`);
        console.log('PDF file generated successfully.');

        // Fetch and save issues as JSON file
        const issues = await fetchIssues(repoOwner, repoName);
        const importantIssueDetails = issues.slice(0, 10).map(issue => ({
            issueNumber: issue.number,
            title: issue.title,
            description: issue.body,
            url: issue.html_url,
            createdAt: issue.created_at,
            author: {
                login: issue.user.login,
                avatarUrl: issue.user.avatar_url
            }
        }));
        await fs.writeFile(`${repoName}_issues.json`, JSON.stringify(importantIssueDetails, null, 2));

        // Respond with generated files and issues
        const response = {
            mdxFile: `${repoName}.mdx`,
            pdfFile: `${repoName}.pdf`,
            issuesFile: `${repoName}_issues.json`,
            mdxContent: finalMdxContent,
            issues: importantIssueDetails
        };
        res.json(response);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        // Clean up cloned repository after a delay
        cleanupRepository(repoName);
    }
});

// API endpoint to handle user requests for custom changes and issue fixing
app.post('/fix-issue', async (req, res) => {
    const { githubRepoURL, customChanges, issueNumber } = req.body;

    try {
        // Extract repo owner and repo name from the GitHub repo URL
        const urlParts = githubRepoURL.split('/');
        const repoOwner = urlParts[urlParts.length - 2];
        const repoName = urlParts[urlParts.length - 1];

        // Kill any existing clone process
        if (cloneProcess !== null) {
            cloneProcess.kill();
            cloneProcess = null;
        }

        // Clone the repository
        cloneProcess = child_process.exec(`git clone ${githubRepoURL}`, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error cloning repository: ${error}`);
                res.status(500).json({ error: 'Internal server error' });
                return;
            }

            console.log(`Repository cloned successfully: ${githubRepoURL}`);

            try {
                // Fetch code from the cloned repository
                const { mdxContent: finalMdxContent } = await traverseDirectory(repoName, '# Repository Code\n\n', '');

                // Fetch issues from the cloned repository
                const issues = await fetchIssues(repoOwner, repoName);

                // Add custom changes to the code
                let modifiedCode = `You are a software developer. Below is the Code, issues and User request to make changes. Make sure to make changes in the code given according to the issue given by fixing the issue:\n\n\n` + finalMdxContent + '\n\nCustom Changes:\n' + customChanges;

                // If issueNumber is provided, find the issue with that number and append it to the modified code
                if (issueNumber) {
                    const targetIssue = issues.find(issue => issue.number === issueNumber);
                    if (targetIssue) {
                        modifiedCode += `\n\nFix the given Issue: ${issueNumber}:\n${targetIssue.title}\n${targetIssue.body}`;
                    }
                }

                // Call the AI model to fix the issue
                const response = await runChat(modifiedCode);
                res.json({ response });
            } catch (error) {
                console.error('Error:', error.message);
                res.status(500).json({ error: 'Internal server error' });
            } finally {
                // Clean up cloned repository after a delay
                cleanupRepository(repoName);
            }
        });

        cloneProcess.on('exit', (code, signal) => {
            if (code !== 0) {
                console.error(`Git clone process exited with code ${code} and signal ${signal}`);
            }
        });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
        cleanupRepository(repoName);
    }
});

// Function to clean up cloned repository after a delay
function cleanupRepository(repoName) {
    setTimeout(async () => {
        try {
            execSync(`rm -rf ${repoName}`);
            console.log('Repository cleaned up successfully.');
        } catch (cleanupError) {
            console.error('Error cleaning up repository:', cleanupError.message);
        }
    }, 5000); // Delay cleanup by 5 seconds
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

module.exports = app;