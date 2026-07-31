# One-time setup

You have two folders. This merges them into one repository.

    ~/Documents/systemsatlasproject_site     the deployed site
    ~/Documents/systems-atlas                this repo

Everything from the deployed site is already here **except** the fonts and the
four app icons, which I could not generate. Bring those across:

    cd ~/Documents
    cp systemsatlasproject_site/assets/fonts/*.woff2  systems-atlas/site/assets/fonts/
    cp systemsatlasproject_site/assets/tools/*.png    systems-atlas/site/assets/tools/

Check they landed:

    ls systems-atlas/site/assets/fonts   # 5 .woff2 files
    ls systems-atlas/site/assets/tools   # 4 .png files

Then build and compare against what is live:

    cd systems-atlas
    npm install
    npm run build
    open dist/index.html

`dist/` should match your current site. Once it does, the old folder can go.

## Git

    cd ~/Documents/systems-atlas
    git init
    git add .
    git commit -m "Systems Atlas: taxonomy as data, site generated from it"
    git branch -M main
    git remote add origin git@github.com:<you>/systems-atlas.git
    git push -u origin main

## Cloudflare Pages

Point the existing project at the repo instead of at uploaded files.

    Build command:       npm run build
    Output directory:    dist
    Node version:        20

Deploy once and check the live site before deleting anything.

## Then delete

    rm -rf ~/Documents/systemsatlasproject_site

Only after the Pages deploy from the repo is confirmed working.
