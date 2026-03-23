import { spawn } from 'child_process';
import chalk from 'chalk';

let botProcess;
let restartCount = 0;
const MAX_RESTARTS = 5;
const RESTART_DELAY = 5000; // 5 seconds

function startBot() {
    console.log(chalk.cyan.bold('[MANAGER]'), chalk.cyan('Starting bot...'));

    botProcess = spawn('node', ['index.js'], {
        stdio: 'inherit',
        shell: true
    });

    botProcess.on('exit', (code, signal) => {
        if (code === 0) {
            console.log(chalk.green.bold('[MANAGER]'), chalk.green('Bot exited normally'));
            process.exit(0);
        } else {
            restartCount++;
            console.log(chalk.red.bold('[MANAGER]'), chalk.red(`Bot crashed with code ${code} (Restart ${restartCount}/${MAX_RESTARTS})`));

            if (restartCount >= MAX_RESTARTS) {
                console.log(chalk.red.bold('[MANAGER]'), chalk.red('Max restart attempts reached. Exiting...'));
                process.exit(1);
            }

            console.log(chalk.yellow.bold('[MANAGER]'), chalk.yellow(`Restarting in ${RESTART_DELAY / 1000} seconds...`));
            setTimeout(() => {
                startBot();
            }, RESTART_DELAY);
        }
    });

    botProcess.on('error', (error) => {
        console.log(chalk.red.bold('[MANAGER]'), chalk.red('Failed to start bot:'), error);
    });
}

// Handle process termination
process.on('SIGINT', () => {
    console.log(chalk.yellow.bold('[MANAGER]'), chalk.yellow('Received SIGINT, shutting down...'));
    if (botProcess) {
        botProcess.kill();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log(chalk.yellow.bold('[MANAGER]'), chalk.yellow('Received SIGTERM, shutting down...'));
    if (botProcess) {
        botProcess.kill();
    }
    process.exit(0);
});

console.log(chalk.cyan.bold('[MANAGER]'), chalk.cyan('Bot Manager Started'));
startBot();
