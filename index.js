const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const markdownPdf = require('markdown-pdf');
const axios = require('axios');
const cors = require('cors');
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
app.use(express.raw());

const PORT = process.env.PORT;
const API_KEY = process.env.YOUR_API_KEY;
const MODEL_NAME = "gemini-1.0-pro";

async function runChat(inputData) {
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
    return result.response.text();
}

// Define a new API endpoint to handle user requests for code changes
app.post('/code-changes', async (req, res) => {
    const { mdxContent, issues, userRequest } = req.body;
    console.log(req.body);

    try {
        // Prepare input data for the AI model
        const inputData = `${mdxContent}\n\nIssues:\n${JSON.stringify(issues)}\n\nUser Request: ${userRequest}`;

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
function traverseDirectory(dir, mdxContent, pdfContent) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = `${dir}/${file}`;
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            const hasCodeFiles = fs.readdirSync(filePath).some(fileName => fileName.endsWith('.js') || fileName.endsWith('.jsx') || fileName.endsWith('.ts') || fileName.endsWith('.tsx') || fileName.endsWith('.py') || fileName.endsWith('.css') || fileName.endsWith('.json')); // Add more file extensions if needed
            if (hasCodeFiles) {
                mdxContent += `## ${filePath}\n\n`;
                pdfContent += `## ${filePath}\n\n`;
                const { mdxContent: nestedMdxContent, pdfContent: nestedPdfContent } = traverseDirectory(filePath, '', ''); // Recursive call with empty content strings
                mdxContent += nestedMdxContent;
                pdfContent += nestedPdfContent;
            }
        } else if (file !== '.gitignore' && file !== 'package-lock.json') { // Exclude certain files
            // Check file extension and skip if it's an image or ICO file
            const fileExtension = file.split('.').pop().toLowerCase();
            if (['jpg', 'jpeg', 'png', 'gif', 'ico'].includes(fileExtension)) {
                return;
            }
            
            // Read the file content only if it's not an image or ICO file
            let fileContent = '';
            if (!['jpg', 'jpeg', 'png', 'gif', 'ico'].includes(fileExtension)) {
                fileContent = fs.readFileSync(filePath, 'utf8').replace(/\r?\n|\r/g, ''); // Replace line breaks and carriage returns
            }

            mdxContent += `\`${filePath}\`\n\n\`\`\`javascript\n${fileContent}\n\`\`\`\n\n`;
            pdfContent += `File Path: ${filePath}\n\nCode:\n\n${fileContent}\n\n`;
        }
    });
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

        const { mdxContent: finalMdxContent, pdfContent: finalPdfContent } = traverseDirectory(repoName, mdxContent, pdfContent);

        // Save MDX file
        fs.writeFileSync(`${repoName}.mdx`, finalMdxContent);

        // Save PDF file
        markdownPdf().from.string(finalPdfContent).to(`${repoName}.pdf`, function () {
            console.log('PDF file generated successfully.');
        });

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
        fs.writeFileSync(`${repoName}_issues.json`, JSON.stringify(importantIssueDetails, null, 2));

        // Respond with generated files and issues
        const response = {
            mdxFile: `${repoName}.mdx`,
            pdfFile: `${repoName}.pdf`,
            issuesFile: `${repoName}_issues.json`,
            mdxContent: finalMdxContent, // Adding MDX content to the response
            issues: importantIssueDetails // Adding issues to the response
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

// Function to clean up cloned repository after a delay
function cleanupRepository(repoName) {
    setTimeout(() => {
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