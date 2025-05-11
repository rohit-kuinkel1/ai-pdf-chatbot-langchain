import { VectorStoreRetriever } from '@langchain/core/vectorstores';
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { createClient as supabaseCreateClient } from '@supabase/supabase-js';
import { RunnableConfig } from '@langchain/core/runnables';
import { Pool } from 'pg';

import {BaseConfigurationAnnotation, ensureBaseConfiguration} from './configuration.js';

const embeddings = new OpenAIEmbeddings({
  model: 'text-embedding-3-small',
});

export async function makeSupabaseRetriever(configuration: typeof BaseConfigurationAnnotation.State): Promise<VectorStoreRetriever> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables are not defined',);
  }

  const supabaseClient = supabaseCreateClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const vectorStore = new SupabaseVectorStore(embeddings, {
    client: supabaseClient,
    tableName: 'documents',
    queryName: 'match_documents',
  });

  return vectorStore.asRetriever({
    k: configuration.document_count,
    filter: configuration.filterKwargs,
  });
}

async function makePostgresRetriever(configuration: typeof BaseConfigurationAnnotation.State): Promise<VectorStoreRetriever> {
  if (!process.env.PG_CONNECTION_STRING) {
    throw new Error('PG_CONNECTION_STRING environment variable is not defined');
  }

  const pool = new Pool({ 
    connectionString: process.env.PG_CONNECTION_STRING 
  });

  const vectorStore = await PGVectorStore.initialize(embeddings, {
      pool,             
      tableName: 'documents',
    }
  );
  
  return vectorStore.asRetriever({
    k: configuration.document_count,
    filter: configuration.filterKwargs,
  });
}


export async function makeRetriever(config: RunnableConfig): Promise<VectorStoreRetriever> {
  const configuration = ensureBaseConfiguration(config);
  switch (configuration.retrieverProvider) {
    case 'supabase':
      return makeSupabaseRetriever(configuration);
    case 'postgres':
      return makePostgresRetriever(configuration);
    default:
      throw new Error(`Unsupported retriever provider: ${configuration.retrieverProvider}`);
  }
}
