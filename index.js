const puppeteer = require('puppeteer');
const cron = require('cron');
const download = require('download-file');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const nodemailer = require('nodemailer');
const express = require('express');
require('dotenv').config();

function delay(milisec) {
    return new Promise(resolve => {
        setTimeout(() => { resolve('') }, milisec);
    })
}

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

let transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "raa.reader44@gmail.com",
        pass: process.env.PASSWORD
    }
});

let params = require('./params.json');
log("Starting bot with params : ");
console.log(params);

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


function createCronTask(cronScheduling) {

    return (new cron.CronJob(cronScheduling, () => {
        (async () => {

            log("Starting Cron schedule");

            let requestUrl = 'https://www.loire-atlantique.gouv.fr/Publications/Recueil-des-actes-administratifs-RAA-en-Loire-Atlantique/';
            const current = new Date();
            requestUrl = requestUrl + current.getFullYear().toString() + '/';
            requestUrl = requestUrl + frenchMonth[current.getMonth()];
            const browser = await puppeteer.launch();
            const page = await browser.newPage();
            await page.goto(requestUrl);
            const pagination = await page.$$('.sous_rub_seule .pagination');
            if(pagination.length !== 0){
                const spanList = await page.$$('.sous_rub_seule .pagination>span');
                await page.evaluate((selector) => document.querySelector(selector).click(), '.pagination>span:nth-child(' + spanList.length.toString() +') a');
                await delay(5000); //Prefecture website is lagged as fuck
            }
            const node = await page.$$('.sous_rub_seule ul li a');
            if (node.length === 0) {
                log("No RAA this month");
                return;
            }
            const title = await page.evaluate(el => el.textContent, node[node.length - 1]);
            if (title === params.lastTitle) {
                log("No new RAA");
                return;
            }
            const link = 'https://www.loire-atlantique.gouv.fr' + await page.evaluate(el => el.getAttribute('href'), node[node.length - 1]);
            await browser.close();
            log("Last RAA title : " + title);
            download(link, {
                directory: "",
                filename: "RAA.pdf"
            }, function (err) {
                if (err) {
                    log("PDF download error");
                    console.log(err);
                }
            });

            const buffer = fs.readFileSync("RAA.pdf");

            try {
                const data = await pdfParse(buffer);
                let text = data.text.toLowerCase();
                let containSearchWords = {'total': 0, 'list': []};

                for (searchWord of params.searchWords) {
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
                    params.lastTitle = title;
                    await updateParams(params)
                    return;
                }

                for (mandatoryWord of params.mustContainWords) {
                    if (!containSearchWords.list.includes(mandatoryWord) && mandatoryWord !== "") {
                        log(`Mandatory word ${mandatoryWord} not found`);
                        params.lastTitle = title;
                        await updateParams(params)
                        return;
                    }
                }

                let wordsFound = '';
                for (word of containSearchWords.list) {
                    wordsFound = wordsFound + word + ", ";
                }
                let mailOptions = {
                    from: 'raa.reader44@gmail.com',
                    to: params.receiverMail,
                    subject: title,
                    text: 'Rapport du bot RAAreader : les mots ' + wordsFound.slice(0, -2) + " ont été trouvés dans le document " + title + " un total de " + containSearchWords.total + " fois.",
                    attachments: {path: "RAA.pdf"}
                };

                transporter.sendMail(mailOptions, function (error, info) {
                    if (error) {
                        log("Email sending error :");
                        console.log(error);
                    } else {
                        log('Email sent: ' + info.response);
                    }
                });

                params.lastTitle = title;
                await updateParams(params)

            } catch (err) {
                throw new Error(err);
            }
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

app.get('/title', function (req, res) {
    res.status(200).format({
        'text/html': function () {
            res.send('<p>Dernier RAA analysé : ' + params.lastTitle + '</p>');
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