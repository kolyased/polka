// Local browser QA only. Not included in the deployment image.
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {dataDir,list} from '../storage.mjs';
writeFileSync(path.join(dataDir,'qa-books.json'),JSON.stringify(list('book:')),{mode:0o600});
