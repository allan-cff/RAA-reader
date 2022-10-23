const puppeteer = require('puppeteer');
const cron = require('cron');
const pdfParse = require('pdf-parse');
const fs = require('node:fs');
const nodemailer = require('nodemailer');
const express = require('express');
const axios = require('axios');
require('dotenv').config();
let params = {};


async function updateParams(params) {
    let stringJson = JSON.stringify(params);
    await fs.writeFile("params.json", stringJson, (err) => {
        if (err) {
            log("Params writing error")
            console.log(err);
        }
    });
    log("Params Updated");
}

function log(message){
    console.log(`[${new Date(Date.now()).toLocaleTimeString()}] ${message}`);
}

function delay(milisec) {
    return new Promise(resolve => {
        setTimeout(() => { resolve('') }, milisec);
    })
}

let transport = nodemailer.createTransport({
    host: process.env.HOST,
    port: process.env.PORT,
    auth: {
        user: process.env.USER,
        pass: process.env.PASS
    }
});


try {
    const data = fs.readFileSync('./params.json', 'utf8');
    params = JSON.parse(data);
    log("Starting bot with params : ");
    console.log(params);
} catch (err) {
    console.error(err);
}

const frenchMonth = {
    0: 'Janvier',
    1: 'Fevrier',
    2: 'Mars',
    3: 'Avril',
    4: 'Mai',
    5: 'Juin',
    6: 'Juillet',
    7: 'Aout',
    8: 'Septembre',
    9: 'Octobre',
    10: 'Novembre',
    11: 'Decembre'
};

async function readRAA(link, title) {
    log("Evaluated RAA : " + link);

    const response = await axios({
        url: link,
        method: 'GET',
        responseType: 'arraybuffer'
    })

    const buffer = await Buffer.from(response.data)

    try {
        const data = await pdfParse(buffer);
        let text = data.text.toLowerCase();
        let containSearchWords = {'total': 0, 'list': []};

        for (let searchWord of params.searchWords) {
            if (text.includes(searchWord.toLowerCase())) {
                containSearchWords.list.push(searchWord); //Verifie si le mot est présent une fois
                log(searchWord + " found !");
                while (text.includes(searchWord.toLowerCase())) { //Compte le nombre d'occurences du mot
                    text = text.substring(text.indexOf(searchWord.toLowerCase()) + searchWord.length);
                    containSearchWords.total++;
                }
            }
        }

        if (containSearchWords.total < params.minimumWordsLimit || containSearchWords.total === 0) {
            log(`Not enough search words found, found ${containSearchWords.total.toString()}, need ${params.minimumWordsLimit.toString()}`);
            return;
        }

        for (let mandatoryWord of params.mustContainWords) {
            if (!containSearchWords.list.includes(mandatoryWord) && mandatoryWord !== "") {
                log(`Mandatory word ${mandatoryWord} not found`);
                return;
            }
        }

        let wordsFound = '';
        for (let word of containSearchWords.list) {
            wordsFound = wordsFound + word + ", ";
        }
        let mailOptions = {
            from: 'raa.reader44@gmail.com',
            to: params.receiverMail,
            subject: title,
            text: 'Rapport du bot RAAreader : les mots ' + wordsFound.slice(0, -2) + " ont été trouvés dans le document " + title + " un total de " + containSearchWords.total + " fois.\n"+link,
        };

        transport.sendMail(mailOptions, function (error, info) {
            if (error) {
                log("Email sending error :");
                console.log(error);
            } else {
                log('Email sent: ' + info.response);
            }
        });
    } catch (err) {
        console.error(new Error(err));
    }
}


function createCronTask(cronScheduling) {

    return (new cron.CronJob(cronScheduling, () => {
        (async () => {

            log("Starting Cron schedule");

            let requestUrl = 'https://www.loire-atlantique.gouv.fr/Publications/Recueil-des-actes-administratifs-RAA-en-Loire-Atlantique/';
            const current = new Date();
            requestUrl = requestUrl + current.getFullYear().toString() + '/';
            requestUrl = requestUrl + frenchMonth[current.getMonth()];
            const browser = await puppeteer.launch({headless: true});
            const page = await browser.newPage();
            await page.goto(requestUrl);
            let nodeList = [];
            nodeList.push(await page.$$('.sous_rub_seule ul li a'))
            if (nodeList[0].length === 0) {
                log("No RAA this month");
                return;
            }
            const pagination = await page.$$('.sous_rub_seule .pagination');
            if(pagination.length !== 0){
                const spanList = await page.$$('.sous_rub_seule .pagination .pages>span');
                for(let i = 2; i <= spanList.length; i++){
                    await page.evaluate(`document.querySelector(".pagination .pages .other:nth-child(3) a").click()`)
                    await delay(5000) //prefercture website is lagged as fuck
                    nodeList.push(await page.$$('.sous_rub_seule ul li a'))
                    await page.screenshot({path:`${i.toString(10)}.png`})
                }
            }
            if(! "checkedRAA" in params){
                params["checkedRAA"] = [];
            }
            for(let node of nodeList){
                for(let el of node){
                    const link = encodeURI("https://www.loire-atlantique.gouv.fr" + await page.evaluate(el => el.getAttribute('href'), el));
                    const title = await page.evaluate(el => el.innerHTML, el);
                    if(!params.checkedRAA.includes(title)){
                        await readRAA(link, title)
                        params.checkedRAA.push(title);
                        await updateParams(params)
                    }
                }
            }

            await browser.close()
        })();
    }, {}));
}

checkLatestRAA = createCronTask(params.cronScheduling);
checkLatestRAA.start();

const app = express();

app.use(express.urlencoded({
    extended: true
}))

app.post('/submit', function (req, res) {
    params.receiverMail = req.body.clientMail;
    params.searchWords = req.body.searchWords.split(' ');
    params.minimumWordsLimit = parseInt(req.body.occurences[0], 10);
    params.mustContainWords = req.body.mandatorySearchWords.split(' ');
    (async () => {
        await updateParams(params);
    })();
    res.status(200).send("Paramètres modifiés !");
});

app.post('/cron', function (req, res) {
    let minutes = "*";
    if (parseInt(req.body.frequency.substring(3, 5), 10) > 0) {
        minutes = "*/" + parseInt(req.body.frequency.substring(3, 5), 10).toString();
    }
    if (parseInt(req.body.frequency.substring(0, 2), 10) > 0 && parseInt(req.body.frequency.substring(3, 5), 10) === 0) {
        minutes = new Date().getMinutes().toString();
    }
    let hours;
    if (parseInt(req.body.frequency.substring(0, 2), 10) > 0) {
        hours = "*/" + parseInt(req.body.frequency.substring(0, 2), 10).toString();
    } else {
        hours = "*";
    }
    params.cronScheduling = minutes + " " + hours + " * * *";
    (async () => {
        await updateParams(params);
    })();
    checkLatestRAA.setTime(new cron.CronTime(params.cronScheduling));
    checkLatestRAA.start();
    res.status(200).send("Régime d'exécution mis à jour !");
});

app.post('/fire', function (req, res) {
    (async () => {
        await updateParams(params);
    })();
    checkLatestRAA.fireOnTick();
    res.status(200).send("Script déclenché !");
});

app.get('/titles', function (req, res) {
    res.status(200).format({
        'text/html': function () {
            res.send(params.checkedRAA.reduce((prev, nex) => `${prev}<br>${nex}`, "</p>Liste des RAA analysés : ") + '</p>');
        }
    });
});

app.post('/title', function (req, res) {
    res.status(200).format({
        'text/html': function () {
            res.send('<p>Le document : ' + params.lastTitle + ' sera de nouveau analysé lors de la prochaine execution.</p>')
        }
    });
    params.lastTitle = "";
    (async () => {
        await updateParams(params);
    })();
});

app.get('/time', function (req, res) {
    res.status(200).format({
        'text/html': function () {
            res.send('<p>Dernière execution : ' + new Date(checkLatestRAA.lastDate()).toTimeString() + '<br>Prochaine execution : ' + new Date(checkLatestRAA.nextDates()).toTimeString() + '</p>')
        }
    });
});

app.get('*', function (req, res) {
    res.sendFile('index.html', {root: '.'});
});

app.listen(8080, () => {
    log("Web server is listening")
})