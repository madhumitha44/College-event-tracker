require('dotenv').config();
const { DynamoDBClient, ListTablesCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION });

async function testConnection() {
    try {
        const results = await client.send(new ListTablesCommand({}));
        console.log("✅ Connection Successful! Found tables:", results.TableNames);
    } catch (err) {
        console.error("❌ Connection Failed:", err.message);
    }
}
testConnection();