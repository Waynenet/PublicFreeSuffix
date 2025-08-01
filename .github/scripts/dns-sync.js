const DNSRecordManager = require('./services/dns-record-manager');
const FileUtils = require('./utils/file-utils');
const logger = require('./logger');
const path = require('path');

class DNSSyncHandler {
  constructor() {
    this.dnsManager = new DNSRecordManager();
  }

  /**
   * Parse domain from filename or full domain string
   * Supports domains with hyphens and punycode format
   * @param {string} domainString - Full domain string (e.g., "new-dns-example.no.kg")
   * @returns {Object} - { domain: string, sld: string }
   */
  static parseDomain(domainString) {
    if (!domainString || typeof domainString !== 'string') {
      throw new Error('Domain string is required and must be a string');
    }

    // Remove file path and extension if present
    let cleanDomain = domainString
      .replace(/^whois\//, '')  // Remove whois/ prefix
      .replace(/\.json$/, '');  // Remove .json extension

    logger.info(`Parsing domain from: ${domainString} -> ${cleanDomain}`);

    // Split by dots and handle multi-level SLDs
    const parts = cleanDomain.split('.');
    
    if (parts.length < 2) {
      throw new Error(`Invalid domain format: ${domainString}. Expected format: domain.sld`);
    }

    // For domains like "new-dns-example.no.kg", we need to handle multi-level SLDs
    // The last part is always the TLD, and everything before the last dot is the SLD
    // The domain name is everything before the SLD
    
    if (parts.length === 2) {
      // Simple case: domain.sld (e.g., "example.no.kg")
      return {
        domain: parts[0],
        sld: parts[1]
      };
    } else if (parts.length === 3) {
      // Multi-level SLD case: domain.sld.tld (e.g., "new-dns-example.no.kg")
      return {
        domain: parts[0],
        sld: `${parts[1]}.${parts[2]}`
      };
    } else {
      // Handle more complex cases (though unlikely for this use case)
      const domain = parts[0];
      const sld = parts.slice(1).join('.');
      return { domain, sld };
    }
  }

  /**
   * Main handler function
   */
  async handleSync() {
    try {
      // Determine trigger type
      const triggerType = this.determineTriggerType();
      logger.info(`Starting DNS sync process for ${triggerType} trigger`);
      
      if (triggerType === 'manual') {
        return await this.handleManualTrigger();
      } else {
        return await this.handlePRMerge();
      }
      
    } catch (error) {
      logger.error('DNS sync process failed:', error);
      
      // Write error result
      const errorResult = {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        triggerType: this.determineTriggerType()
      };
      
      await FileUtils.writeResultFile(errorResult);
      throw error;
    }
  }

  /**
   * Determine trigger type
   */
  determineTriggerType() {
    const manualDomain = process.env.MANUAL_DOMAIN;
    const manualOperation = process.env.MANUAL_OPERATION;
    
    if (manualDomain || manualOperation) {
      return 'manual';
    }
    return 'pr_merge';
  }

  /**
   * Handle manual trigger
   */
  async handleManualTrigger() {
    logger.info('Processing manual DNS sync trigger');
    
    // Get manual trigger parameters
    const domain = process.env.MANUAL_DOMAIN;
    const operation = process.env.MANUAL_OPERATION || 'auto';
    const whoisFile = process.env.MANUAL_WHOIS_FILE;
    const forceSync = process.env.FORCE_SYNC === 'true';
    const whoisFilePath = process.env.WHOIS_FILE_PATH;
    
    logger.info(`Manual trigger parameters: domain=${domain}, operation=${operation}, whoisFile=${whoisFile}, forceSync=${forceSync}, whoisFilePath=${whoisFilePath}`);
    
    // Validate parameters
    if (!domain && !whoisFile) {
      throw new Error('Either MANUAL_DOMAIN or MANUAL_WHOIS_FILE must be provided for manual trigger');
    }
    
    let whoisData = null;
    let targetDomain = domain;
    
    // If WHOIS file is specified, read data from file
    if (whoisFile) {
      let fullPath;
      if (whoisFilePath) {
        // Use the separate WHOIS file path
        fullPath = `${whoisFilePath}/${whoisFile.replace('whois/', '')}`;
      } else {
        fullPath = whoisFile.startsWith('whois/') ? whoisFile : `whois/${whoisFile}`;
      }
      logger.info(`Reading WHOIS data from file: ${fullPath}`);
      
      try {
        whoisData = await FileUtils.readWhoisFile(fullPath);
        targetDomain = whoisData.domain;
        logger.info(`Extracted domain from WHOIS file: ${targetDomain}`);
      } catch (error) {
        if (forceSync) {
          logger.warn(`Failed to read WHOIS file ${fullPath}, but continuing due to force sync: ${error.message}`);
        } else {
          throw new Error(`Failed to read WHOIS file ${fullPath}: ${error.message}`);
        }
      }
    }
    
    // If domain is specified but no WHOIS file, try to find corresponding WHOIS file
    if (domain && !whoisData) {
      let domainFile;
      if (whoisFilePath) {
        // Use the separate WHOIS file path
        domainFile = `${whoisFilePath}/${domain}.json`;
      } else {
        domainFile = `whois/${domain}.json`;
      }
      logger.info(`Attempting to read WHOIS file for domain: ${domainFile}`);
      
      try {
        whoisData = await FileUtils.readWhoisFile(domainFile);
        logger.info(`Successfully read WHOIS data for domain: ${domain}`);
      } catch (error) {
        if (forceSync) {
          logger.warn(`Failed to read WHOIS file for domain ${domain}, but continuing due to force sync: ${error.message}`);
        } else {
          throw new Error(`Failed to read WHOIS file for domain ${domain}: ${error.message}`);
        }
      }
    }
    
    // If still no WHOIS data, create basic data based on domain
    if (!whoisData && domain) {
      logger.info(`Creating basic WHOIS data for domain: ${domain}`);
      
      // Parse domain using the new robust parser
      const { domain: domainName, sld } = DNSSyncHandler.parseDomain(domain);
      
      whoisData = {
        domain: domainName,
        sld: sld,
        operation: operation
      };
    }
    
    // Map operation types for compatibility
    const mappedOperation = this.mapOperationType(operation);
    logger.info(`Mapped manual operation from ${operation} to ${mappedOperation}`);
    
    // Execute DNS sync operation
    const result = await this.dnsManager.handleManualSync(
      process.env.PR_TITLE || 'Manual DNS Sync',
      whoisData,
      {
        operation: mappedOperation,
        forceSync: forceSync,
        triggeredBy: process.env.GITHUB_ACTOR || 'unknown'
      }
    );
    
    // Write result file
    await FileUtils.writeResultFile(result);
    
    logger.info('Manual DNS sync process completed successfully');
    return result;
  }

  /**
   * Handle PR merge trigger
   */
  async handlePRMerge() {
    logger.info('Processing PR merge DNS sync trigger');
    
    // Get environment variables
    const prTitle = process.env.PR_TITLE;
    const whoisFilePath = process.env.WHOIS_FILE_PATH;
    const operation = process.env.OPERATION || 'auto';
    
    if (!prTitle) {
      throw new Error('PR_TITLE environment variable is required');
    }
    
    logger.info(`Processing PR: ${prTitle}`);
    logger.info(`WHOIS file path: ${whoisFilePath}`);
    logger.info(`Operation: ${operation}`);
    
    // Read PR files from JSON file
    let files = [];
    try {
      const fs = require('fs');
      const prFilesPath = path.join(process.cwd(), 'pr-files.json');
      logger.info(`Reading PR files from: ${prFilesPath}`);
      
      if (fs.existsSync(prFilesPath)) {
        const prFilesContent = fs.readFileSync(prFilesPath, 'utf8');
        files = JSON.parse(prFilesContent);
        logger.info(`Successfully read PR files from file`);
      } else {
        logger.warn('PR files JSON file not found, using empty array');
        files = [];
      }
    } catch (error) {
      logger.error(`Failed to read PR files from JSON file: ${error.message}`);
      throw new Error(`Failed to read PR files: ${error.message}`);
    }
    
    logger.info(`Parsed PR files: ${JSON.stringify(files, null, 2)}`);
    
    const whoisFile = FileUtils.extractWhoisFiles(files);
    logger.info(`Found whois file: ${whoisFile.filename} (status: ${whoisFile.status})`);
    
    // Handle different file statuses
    if (whoisFile.status === 'removed') {
      // For deletion, we need to extract domain info from the filename
      logger.info(`Processing deletion for file: ${whoisFile.filename}`);
      
      // Parse domain to get domain name and sld using the new robust parser
      const { domain: domainName, sld } = DNSSyncHandler.parseDomain(whoisFile.filename);
      logger.info(`Parsed domain: ${domainName}, SLD: ${sld}`);
      
      // Try to read the extracted file content for additional validation
      let whoisData = null;
      if (whoisFilePath) {
        try {
          const extractedFileName = whoisFile.filename.replace('whois/', '');
          const extractedFilePath = `${whoisFilePath}/${extractedFileName}`;
          logger.info(`Attempting to read extracted file content from: ${extractedFilePath}`);
          
          whoisData = await FileUtils.readWhoisFile(extractedFilePath);
          logger.info(`Successfully read extracted WHOIS data for deletion`);
          
          // Validate that the extracted data matches the filename
          if (whoisData.domain !== domainName || whoisData.sld !== sld) {
            logger.warn(`Extracted WHOIS data domain/sld mismatch: expected ${domainName}.${sld}, got ${whoisData.domain}.${whoisData.sld}`);
          }
        } catch (error) {
          logger.warn(`Failed to read extracted file content, proceeding with filename-based deletion: ${error.message}`);
        }
      }
      
      // Execute DNS deletion operation
      const result = await this.dnsManager.handlePRMerge(prTitle, { 
        domain: domainName, 
        sld: sld,
        operation: 'delete',
        ...(whoisData && { originalData: whoisData }) // Include original data if available
      });
      
      // Write result file
      await FileUtils.writeResultFile(result);
      
      logger.info('DNS deletion process completed successfully');
      return result;
    } else {
      // For registration/update, read the whois file content from separate path
      let filePath = whoisFile.filename;
      if (whoisFilePath) {
        // Use the separate WHOIS file path
        const fileName = whoisFile.filename.replace('whois/', '');
        filePath = `${whoisFilePath}/${fileName}`;
        logger.info(`Reading WHOIS file from separate path: ${filePath}`);
      }
      
      const whoisData = await FileUtils.readWhoisFile(filePath);
      
      // Map operation types for compatibility
      if (operation !== 'auto') {
        whoisData.operation = this.mapOperationType(operation);
        logger.info(`Mapped operation from ${operation} to ${whoisData.operation}`);
      }
      
      // Execute DNS sync operation
      const result = await this.dnsManager.handlePRMerge(prTitle, whoisData);
      
      // Write result file
      await FileUtils.writeResultFile(result);
      
      logger.info('DNS sync process completed successfully');
      return result;
    }
  }

  /**
   * Map operation types for compatibility between workflow and DNS manager
   */
  mapOperationType(operation) {
    const operationMap = {
      'add': 'registration',
      'update': 'update', 
      'delete': 'remove',
      'registration': 'registration',
      'remove': 'remove'
    };
    
    return operationMap[operation] || operation;
  }
}

// If running this script directly
if (require.main === module) {
  const handler = new DNSSyncHandler();
  
  handler.handleSync()
    .then(result => {
      logger.info('DNS sync completed successfully:', result);
      process.exit(0);
    })
    .catch(error => {
      logger.error('DNS sync failed:', error);
      process.exit(1);
    });
}

module.exports = DNSSyncHandler; 