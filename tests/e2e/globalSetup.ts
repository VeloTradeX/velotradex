import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
export default async function globalSetup() {
  // dotenv mutates process.env in place — nothing else needed
}
