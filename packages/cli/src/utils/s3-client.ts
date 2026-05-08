import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";

export interface BackupConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createS3Client(config: BackupConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true, // Required for SeaweedFS / MinIO
  };
  return new S3Client(clientConfig);
}
