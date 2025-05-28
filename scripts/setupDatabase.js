// This script sets up the necessary database structures for each supported database type

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupSupabase() {
  console.log("Setting up Supabase...");

  // Check if required environment variables are set
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
    );
    return false;
  }

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Check if connection works
    const { data, error } = await supabaseClient
      .from("documents")
      .select("id")
      .limit(1);

    if (error) {
      // Table might not exist, try to create it
      console.log("Creating documents table in Supabase...");

      // Read SQL file for creating tables
      const sqlPath = path.join(__dirname, "sql", "supabase_setup.sql");
      if (!fs.existsSync(sqlPath)) {
        console.error(`Error: SQL file not found: ${sqlPath}`);
        return false;
      }

      const sql = fs.readFileSync(sqlPath, "utf8");
      const { error: createError } = await supabaseClient.rpc("pg_execute", {
        query: sql,
      });

      if (createError) {
        console.error("Error creating Supabase tables:", createError);
        return false;
      }

      console.log("Supabase setup completed successfully");
      return true;
    }

    console.log("Supabase is already set up");
    return true;
  } catch (error) {
    console.error("Error setting up Supabase:", error);
    return false;
  }
}

async function setupPostgres() {
  console.log("Setting up PostgreSQL...");

  // Check if required environment variables are set
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "postgres";
  const database = process.env.POSTGRES_DB || "vectordb";

  try {
    const { Pool } = await import("pg");
    const pool = new Pool({
      host,
      port: parseInt(port, 10),
      user,
      password,
      database,
    });

    // Test connection
    const client = await pool.connect();

    try {
      // Create pgvector extension if it doesn't exist
      await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

      // Check if documents table exists
      const { rows } = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public'
          AND table_name = 'documents'
        );
      `);

      if (!rows[0].exists) {
        console.log("Creating documents table in PostgreSQL...");

        // Read SQL file for creating tables
        const sqlPath = path.join(__dirname, "sql", "postgres_setup.sql");
        if (!fs.existsSync(sqlPath)) {
          console.error(`Error: SQL file not found: ${sqlPath}`);
          return false;
        }

        const sql = fs.readFileSync(sqlPath, "utf8");
        await client.query(sql);

        console.log("PostgreSQL setup completed successfully");
      } else {
        console.log("PostgreSQL is already set up");
      }

      return true;
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error("Error setting up PostgreSQL:", error);
    return false;
  }
}

async function setupMongoDB() {
  console.log("Setting up MongoDB...");

  // Check if required environment variables are set
  if (!process.env.MONGODB_URI) {
    console.error("Error: MONGODB_URI must be set in .env");
    return false;
  }

  const dbName = process.env.MONGODB_DB_NAME || "vectordb";

  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI);

    await client.connect();
    const db = client.db(dbName);

    // Check if collection exists
    const collections = await db
      .listCollections({ name: "documents" })
      .toArray();

    if (collections.length === 0) {
      console.log("Creating documents collection in MongoDB...");

      // Create collection
      await db.createCollection("documents");

      // Create indexes
      await db.collection("documents").createIndex({ content: "text" });
      await db.collection("documents").createIndex({ "metadata.namespace": 1 });

      // Create vector index (for MongoDB Atlas)
      try {
        await db.command({
          createSearchIndex: "documents",
          name: "vector_index",
          definition: {
            mappings: {
              dynamic: true,
              fields: {
                embedding: {
                  dimensions: 1536,
                  similarity: "cosine",
                  type: "knnVector",
                },
              },
            },
          },
        });
      } catch (indexError) {
        console.warn(
          "Warning: Could not create vector index. This is expected for local MongoDB (not Atlas)."
        );
        console.warn(
          "If you are using MongoDB Atlas, check your connection string and permissions."
        );
      }

      console.log("MongoDB setup completed successfully");
    } else {
      console.log("MongoDB is already set up");
    }

    await client.close();
    return true;
  } catch (error) {
    console.error("Error setting up MongoDB:", error);
    return false;
  }
}

async function createSqlDirectory() {
  const sqlDir = path.join(__dirname, "sql");

  if (!fs.existsSync(sqlDir)) {
    fs.mkdirSync(sqlDir);
  }

  //create Supabase SQL setup file
  const supabaseSql = `
-- Enable pgvector extension
create extension if not exists vector;

-- Create documents table if it doesn't exist
create table if not exists documents (
  id uuid primary key,
  content text,
  metadata jsonb,
  embedding vector(1536)
);

-- Create function to match documents
create or replace function match_documents (
  query_embedding vector(1536),
  match_count int default 5,
  filter jsonb default '{}'
) returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where case
    when filter::text != '{}'::text then
      documents.metadata @> filter
    else
      true
    end
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Create index for faster similarity search
create index if not exists documents_embedding_idx on documents
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- Create indexes for metadata fields
create index if not exists documents_metadata_idx on documents using gin (metadata);
create index if not exists documents_metadata_namespace_idx on documents using btree ((metadata->>'namespace'));
`;

  fs.writeFileSync(path.join(sqlDir, "supabase_setup.sql"), supabaseSql);

  // Create PostgreSQL SQL setup file
  const postgresSql = `
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create documents table if it doesn't exist
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  content TEXT,
  metadata JSONB,
  embedding VECTOR(1536)
);

-- Create indexes for faster similarity search
CREATE INDEX IF NOT EXISTS documents_embedding_idx ON documents
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create indexes for metadata fields
CREATE INDEX IF NOT EXISTS documents_metadata_idx ON documents USING GIN (metadata);
CREATE INDEX IF NOT EXISTS documents_metadata_namespace_idx ON documents USING btree ((metadata->>'namespace'));
`;

  fs.writeFileSync(path.join(sqlDir, "postgres_setup.sql"), postgresSql);
}

async function main() {
  console.log("Setting up databases for the PDF Chatbot...");

  // Create SQL directory and files
  await createSqlDirectory();

  // Determine which databases to set up based on .env file
  const setupSupabaseFlag =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
  const setupPostgresFlag =
    process.env.POSTGRES_HOST || process.env.POSTGRES_USER;
  const setupMongoDBFlag = process.env.MONGODB_URI;

  if (!setupSupabaseFlag && !setupPostgresFlag && !setupMongoDBFlag) {
    console.log(
      "No database configuration found in .env. Please configure at least one database."
    );
    process.exit(1);
  }

  // Setup selected databases
  let results = [];

  if (setupSupabaseFlag) {
    const supabaseResult = await setupSupabase();
    results.push({ db: "Supabase", success: supabaseResult });
  }

  if (setupPostgresFlag) {
    const postgresResult = await setupPostgres();
    results.push({ db: "PostgreSQL", success: postgresResult });
  }

  if (setupMongoDBFlag) {
    const mongodbResult = await setupMongoDB();
    results.push({ db: "MongoDB", success: mongodbResult });
  }

  // Print results
  console.log("\nDatabase Setup Results:");
  console.log("=======================");

  for (const result of results) {
    console.log(`${result.db}: ${result.success ? "SUCCESS" : "FAILURE"}`);
  }

  const allSuccess = results.every((r) => r.success);

  if (allSuccess) {
    console.log("\nAll configured databases were set up successfully!");
    console.log(
      "You can now use the PDF Chatbot with your preferred database."
    );
  } else {
    console.log(
      "\nSome database setups failed. Please check the error messages above."
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("An unexpected error occurred:", error);
  process.exit(1);
});
