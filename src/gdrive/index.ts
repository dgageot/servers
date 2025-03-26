#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from 'url';
import http from 'http';

const drive = google.drive("v3");
var httpServer: http.Server;

const server = new Server(
  {
    name: "example-servers/gdrive",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const pageSize = 10;
  const params: any = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  console.error("Listing files");
  try {
    const res = await drive.files.list(params);
    const files = res.data.files!;
    return {
      resources: files.map((file) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType,
        name: file.name,
      })),
      nextCursor: res.data.nextPageToken,
    };
  } catch (error: any) {
    console.error(error);
    return {
      resources: [],
      nextCursor: null,
    };
  }

});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const fileId = request.params.uri.replace("gdrive:///", "");

  // First get file metadata to check mime type
  const file = await drive.files.get({
    fileId,
    fields: "mimeType",
  });

  // For Google Docs/Sheets/etc we need to export
  if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
    let exportMimeType: string;
    switch (file.data.mimeType) {
      case "application/vnd.google-apps.document":
        exportMimeType = "text/markdown";
        break;
      case "application/vnd.google-apps.spreadsheet":
        exportMimeType = "text/csv";
        break;
      case "application/vnd.google-apps.presentation":
        exportMimeType = "text/plain";
        break;
      case "application/vnd.google-apps.drawing":
        exportMimeType = "image/png";
        break;
      default:
        exportMimeType = "text/plain";
    }

    const res = await drive.files.export(
      { fileId, mimeType: exportMimeType },
      { responseType: "text" },
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: exportMimeType,
          text: res.data,
        },
      ],
    };
  }

  // For regular files download content
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  const mimeType = file.data.mimeType || "application/octet-stream";
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: mimeType,
          text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
        },
      ],
    };
  } else {
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: mimeType,
          blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
        },
      ],
    };
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search for files in Google Drive",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "readGoogleDriveFile",
        description: "Read contents of a file from Google Drive",
        inputSchema: {
          type: "object",
          properties: {
            fileId: {
              type: "string",
              description: "Google Drive file ID",
            },
          },
          required: ["fileId"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "search") {
    const userQuery = request.params.arguments?.query as string;
    const escapedQuery = userQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const formattedQuery = `fullText contains '${escapedQuery}'`;

    const res = await drive.files.list({
      q: formattedQuery,
      pageSize: 10,
      fields: "files(id, name, mimeType, modifiedTime, size)",
    });

    const fileList = res.data.files
      ?.map((file: any) => `${file.id} ${file.name} (${file.mimeType})`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Found ${res.data.files?.length ?? 0} files:\n${fileList}`,
        },
      ],
      isError: false,
    };
  } else if (request.params.name === "readGoogleDriveFile") {
    const fileId = request.params.arguments?.fileId as string;

    try {
      // First get file metadata to check mime type
      const file = await drive.files.get({
        fileId,
        fields: "name,mimeType",
      });

      // For Google Docs/Sheets/etc we need to export
      if (file.data.mimeType?.startsWith("application/vnd.google-apps")) {
        let exportMimeType: string;
        switch (file.data.mimeType) {
          case "application/vnd.google-apps.document":
            exportMimeType = "text/markdown";
            break;
          case "application/vnd.google-apps.spreadsheet":
            exportMimeType = "text/csv";
            break;
          case "application/vnd.google-apps.presentation":
            exportMimeType = "text/plain";
            break;
          case "application/vnd.google-apps.drawing":
            exportMimeType = "image/png";
            break;
          default:
            exportMimeType = "text/plain";
        }

        const res = await drive.files.export(
          { fileId, mimeType: exportMimeType },
          { responseType: "text" },
        );

        return {
          content: [
            {
              type: "text",
              text: `File: ${file.data.name}\nContent:\n${res.data}`,
            },
          ],
          isError: false,
        };
      }

      // For regular files download content
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const mimeType = file.data.mimeType || "application/octet-stream";

      if (mimeType.startsWith("text/") || mimeType === "application/json") {
        return {
          content: [
            {
              type: "text",
              text: `File: ${file.data.name}\nContent:\n${Buffer.from(res.data as ArrayBuffer).toString("utf-8")}`,
            },
          ],
          isError: false,
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `File: ${file.data.name}\nContent: [Binary file of type ${mimeType}]`,
            },
          ],
          isError: false,
        };
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading file: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
  throw new Error("Tool not found");
});

const credentialsPath = process.env.GDRIVE_CREDENTIALS_PATH || path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.gdrive-server-credentials.json",
);

async function authenticateAndSaveCredentials() {
  const clientConfig = JSON.parse(
    fs.readFileSync(
      process.env.GDRIVE_OAUTH_PATH || path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../gcp-oauth.keys.json"
      ),
      "utf-8"
    )
  );

  const oauth2Client = new google.auth.OAuth2(
    clientConfig.web.client_id,
    clientConfig.web.client_secret,
    clientConfig.web.redirect_uris[0]
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname === '/oauth2callback') {
        const code = url.searchParams.get('code');
        if (code) {
          // Send success response to browser
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('Authentication successful! You can close this window.');

          console.error("get tokens from code", code);
          await getTokensFromCode(code);
          httpServer.close(); // Close the server after successful auth
          process.exit(0);
        }
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Authentication failed');
    }
  });

  // Listen on port 3000 outside of the request handler
  httpServer.listen(3000, () => {
    console.error('Listening for authentication callback on port 3000...');
  });

  console.log(`Authorize this app by visiting this url: ${authUrl}.  Please show this url to the user so they can use it to authorize the app.`);
}

async function getTokensFromCode(code: string) {
  const clientConfig = JSON.parse(
    fs.readFileSync(
      process.env.GDRIVE_OAUTH_PATH || path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../gcp-oauth.keys.json"
      ),
      "utf-8"
    )
  );

  const oauth2Client = new google.auth.OAuth2(
    clientConfig.web.client_id,
    clientConfig.web.client_secret,
    clientConfig.web.redirect_uris[0]
  );

  const { tokens } = await oauth2Client.getToken(code);
  fs.writeFileSync(credentialsPath, JSON.stringify(tokens));
  console.error("Credentials saved. You can now run the server.");
}

async function loadCredentialsAndRunServer() {
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    const clientConfig = JSON.parse(
      fs.readFileSync(
        process.env.GDRIVE_OAUTH_PATH || path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../gcp-oauth.keys.json"
        ),
        "utf-8"
      )
    );

    const auth = new google.auth.OAuth2(
      clientConfig.web.client_id,
      clientConfig.web.client_secret,
      clientConfig.web.redirect_uris[0]
    );

    auth.setCredentials(credentials);
    google.options({ auth });
    console.error("Credentials loaded. Starting server.");
  } catch (error: any) {
    console.error("Failed to load credentials:", error.message);
    console.error("Starting server without Google Drive authentication.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "auth") {
  authenticateAndSaveCredentials().catch(console.error);
} else {
  loadCredentialsAndRunServer().catch(console.error);
}
