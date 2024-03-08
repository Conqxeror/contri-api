const { execSync } = require('child_process');

const extensions = ["issues.json", "mdx", "pdf"];

const deleteFiles = (extension) => {
  try {
    execSync(`rm -rf *${extension}`);
    console.log(`Deleted *${extension} file!`)
  } catch (error) {
    console.log('Error deleting file: ', error)
  }
  
};

extensions.forEach(deleteFiles);
