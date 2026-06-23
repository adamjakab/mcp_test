import express from 'express';
import { json, urlencoded } from 'body-parser';
import { initializeServer } from './mcp/server';
import { ALLOWED_GITHUB_USER_IDS, PORT, PUBLIC_BASE_URL } from './config/env';
import { oauthRouter } from './oauth/router';
import { bearerAuth } from './oauth/middleware';

const app = express();

// Body parsers
app.use(json());
app.use(urlencoded({ extended: false })); // for /token (application/x-www-form-urlencoded)

// OAuth endpoints (metadata, register, authorize, callback, token).
// Mounted before the /mcp route so the well-known docs are publicly reachable.
app.use(oauthRouter());

// Protect the MCP endpoint with our Bearer JWT middleware. This runs before
// initializeServer attaches its app.all('/mcp', ...) handler.
app.use('/mcp', bearerAuth);

const start = async (): Promise<void> => {
    await initializeServer(app);

    app.listen(PORT, () => {
        console.log(`MCP server is running on port: ${PORT}`);
        console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
        console.log(
            `Allowed GitHub user IDs: ${ALLOWED_GITHUB_USER_IDS.join(', ') || '(none — server is locked down)'}`
        );
    });
};

start().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
});

