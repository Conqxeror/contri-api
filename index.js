const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const markdownPdf = require('markdown-pdf');
const axios = require('axios');
const cors = require('cors');
const markdownIt = require('markdown-it')();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
                fileContent = fs.readFileSync(filePath, 'utf8');
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