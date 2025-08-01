const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

class FileUtils {
  /**
   * Read whois file content
   */
  async readWhoisFile(filePath) {
    try {
      // Get the workspace root directory (two levels up from .github/scripts)
      const workspaceRoot = path.resolve(__dirname, '../../');
      const fullPath = path.join(workspaceRoot, filePath);
      
      logger.info(`Reading whois file: ${fullPath}`);
      logger.info(`Current working directory: ${process.cwd()}`);
      logger.info(`Workspace root: ${workspaceRoot}`);
      
      // Check if file exists before reading
      try {
        await fs.access(fullPath);
        logger.info(`File exists at: ${fullPath}`);
      } catch (accessError) {
        logger.error(`File does not exist at: ${fullPath}`);
        // Try alternative paths
        const altPath1 = path.resolve(process.cwd(), '../../', filePath);
        const altPath2 = path.resolve(process.cwd(), filePath);
        logger.info(`Trying alternative path 1: ${altPath1}`);
        logger.info(`Trying alternative path 2: ${altPath2}`);
        
        // Check if file exists at alternative paths
        try {
          await fs.access(altPath1);
          logger.info(`File found at alternative path 1: ${altPath1}`);
          const content = await fs.readFile(altPath1, 'utf8');
          const whoisData = JSON.parse(content);
          logger.info(`Successfully parsed whois file: ${altPath1}`);
          return whoisData;
        } catch (alt1Error) {
          try {
            await fs.access(altPath2);
            logger.info(`File found at alternative path 2: ${altPath2}`);
            const content = await fs.readFile(altPath2, 'utf8');
            const whoisData = JSON.parse(content);
            logger.info(`Successfully parsed whois file: ${altPath2}`);
            return whoisData;
          } catch (alt2Error) {
            throw new Error(`Whois file not found at any path: ${filePath}`);
          }
        }
      }
      
      const content = await fs.readFile(fullPath, 'utf8');
      const whoisData = JSON.parse(content);
      
      logger.info(`Successfully parsed whois file: ${fullPath}`);
      return whoisData;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Whois file not found: ${filePath}`);
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON format in whois file: ${filePath}`);
      }
      throw new Error(`Failed to read whois file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Extract whois file paths from PR file changes
   */
  extractWhoisFiles(files) {
    const whoisFiles = files.filter(file => 
      file.filename.startsWith('whois/') && 
      file.filename.endsWith('.json')
    );
    
    if (whoisFiles.length === 0) {
      throw new Error('No whois files found in PR changes');
    }
    
    if (whoisFiles.length > 1) {
      throw new Error(`Multiple whois files found in PR changes: ${whoisFiles.map(f => f.filename).join(', ')}`);
    }
    
    return whoisFiles[0];
  }

  /**
   * Extract whois file paths for non-removed files only
   */
  extractNonRemovedWhoisFiles(files) {
    const whoisFiles = files.filter(file => 
      file.filename.startsWith('whois/') && 
      file.filename.endsWith('.json') &&
      file.status !== 'removed'
    );
    
    if (whoisFiles.length === 0) {
      throw new Error('No non-removed whois files found in PR changes');
    }
    
    if (whoisFiles.length > 1) {
      throw new Error(`Multiple non-removed whois files found in PR changes: ${whoisFiles.map(f => f.filename).join(', ')}`);
    }
    
    return whoisFiles[0];
  }

  /**
   * Get full file path
   */
  getFullPath(relativePath, baseDir = process.cwd()) {
    return path.resolve(baseDir, relativePath);
  }

  /**
   * Check if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write result file
   */
  async writeResultFile(result, outputPath = 'dns-sync-result.json') {
    try {
      const resultData = {
        timestamp: new Date().toISOString(),
        ...result
      };
      
      await fs.writeFile(outputPath, JSON.stringify(resultData, null, 2));
      logger.info(`Result written to: ${outputPath}`);
    } catch (error) {
      logger.error(`Failed to write result file: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new FileUtils(); 