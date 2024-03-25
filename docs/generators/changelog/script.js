const _fs = require('fs');
const fs = _fs.promises;

function getPackageVersion(packageName) {
  function getFile(path) {
    try {
      const data = _fs.readFileSync(path, 'utf8');
      return [data, null];
    } catch (e) {
      console.error(e);
      return ['', e];
    }

  }

  const [code, error] = getFile(`../packages/${ packageName }/package.js`);
  if (error) return 'ERR_NO_VERSION';
  for (const line of code.split(/\n/)) {
    // verify if the line has a version
    if (!line.includes('version:')) continue;

    //Package.describe({
    //   summary: 'some description.',
    //   version: '1.2.3' <--- this is the line we want, we assure that it has a version in the previous if
    //});
    const [_, versionValue] = line.split(':');
    if (!versionValue) continue;
    const removeQuotes =
      (v) =>
        v
          .trim()
          .replace(',', '')
          .replace(/'/g, '')
          .replace(/"/g, '');

    if (versionValue.includes('-')) return removeQuotes(versionValue.split('-')[0]);
    return removeQuotes(versionValue);
  }
}

const main = async () => {
  try {
    console.log('started concatenating files');
    const files = await fs.readdir('./generators/changelog/versions', 'utf8');
    const filesStream = files
      .map(file => {
        console.log(`reading file: ${ file }`);
        return {
          fileName: file,
          buf : fs.readFile(`./generators/changelog/versions/${ file }`, 'utf8')
        };
      })
      .map(async ({buf, fileName}, index) => {
        // first file we don't do anything
        // Big file and does not follow the new standard
        if (index === 0) return buf;
        const content = (await buf).toString();
        /**
         * @type {Set<string>}
         */
        const contribuitors = new Set()

        // DSL Replacers
        // [PR #123] -> [PR #123](https://github.com/meteor/meteor/pull/123)
        // [GH meteor/meteor] -> [meteor/meteor](https://github.com/meteor/meteor)
        // package-name@get-version -> package-name@1.3.3

        const file =  content
          .replace(/\[PR #(\d+)\]/g, (_, number) => `[PR](https://github.com/meteor/meteor/pull/${ number })`)
          .replace(/\[GH ([^\]]+)\]/g, (_, name) => {
            contribuitors.add(name);
            return `[${ name }](https://github.com/${ name })`
          })
          .replace(/([a-z0-9-]+)@get-version/g, (_, name) => `${ name }@${ getPackageVersion(name) }`);

        // already have the contribuitors thanks in the file
        if (
           file.includes('## Contributors') ||
           file.includes('#### Special thanks to') || // this must stay here for legacy reasons
           file.includes('[//]: # (Do not edit this file by hand.)')
        ) return file;

        // add the contribuitors
        const contribuitorsList =
           Array
          .from(contribuitors)
          .map(name => `- [@${ name }](https://github.com/${ name }).`)
          .join('\n');

        const doneFile = `${ file }\n\n## Contributors\n\n${ contribuitorsList }\n\n`;

        //SIDE EFFECTS
        // so that this is not ran every time, we will update the last file.
        // this is for the expensive part of the script
        if (index === files.length - 2) await fs.writeFile(`./generators/changelog/versions/${fileName}`, doneFile);

        return doneFile;
      })
      .reverse();
    console.log('Giving some touches to the files');
    const filesContent = await Promise.all(filesStream);
    await fs.writeFile('./history.md', filesContent.join(''));
    console.log('Finished :)');

  } catch (e) {
    console.log(e);
  }

}
main().then(_ => _);
