pipeline {
    agent any

    parameters {
        string(
            name: 'SOURCE_SYMBOL',
            defaultValue: 'XRPUSDT',
            description: 'Binance symbol to mirror  (e.g. XRPUSDT, BTCUSDT, ETHUSDT)'
        )
        string(
            name: 'TARGET_SYMBOL',
            defaultValue: 'XRPQAUSDT',
            description: 'Testnet symbol to write to  (leave blank to use SOURCE_SYMBOL)'
        )
        string(
            name: 'MIN_SIZE',
            defaultValue: '50',
            description: 'Min order size in USDT'
        )
        string(
            name: 'MAX_SIZE',
            defaultValue: '100',
            description: 'Max order size in USDT'
        )
        booleanParam(
            name: 'CREATE_NEW_USERS',
            defaultValue: true,
            description: 'Generate fresh API keys for Maker and Taker users on this run?'
        )
        string(
            name: 'BUFFER_PCT',
            defaultValue: '0',
            description: 'Price buffer on all orders  (e.g. 0.01 = 0.01%)'
        )
        choice(
            name: 'ENABLE_TRADE_SYNC',
            choices: ['false', 'true'],
            description: 'Mirror Binance taker trades on testnet via IOC orders'
        )
    }

    stages {

        // ─────────────────────────────────────────────────────────────────
        stage('Validate') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    def src = params.SOURCE_SYMBOL?.trim()
                    if (!src) error("SOURCE_SYMBOL is required.")

                    def min = params.MIN_SIZE.toFloat()
                    def max = params.MAX_SIZE.toFloat()
                    if (min <= 0) error("MIN_SIZE must be greater than 0.")
                    if (max <= 0) error("MAX_SIZE must be greater than 0.")
                    if (min > max) error("MIN_SIZE (${min}) cannot exceed MAX_SIZE (${max}).")

                    env.SRC = src
                    env.TGT = params.TARGET_SYMBOL?.trim() ?: src
                    echo "Config: ${env.SRC} -> ${env.TGT} | ${min}-${max} USDT | buffer: ${params.BUFFER_PCT}% | tradeSync: ${params.ENABLE_TRADE_SYNC}"
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Kill existing run for same symbol') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    // Kill any previous replicator runs
                    sh "pkill -f 'node replicator.js' || true"
                    sh "pkill -f 'node reporter.js' || true"
                    sleep(time: 3, unit: 'SECONDS')
                    echo "Previous instances stopped."
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Checkout') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                git url: 'https://github.com/MAniTejReddy1/testnet_replicator.git', branch: 'main'
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Install dependencies') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                // Install replicator deps + reporter deps
                sh 'npm install'
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Generate Test Credentials') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    if (params.CREATE_NEW_USERS) {
                        echo "Creating new users and API keys..."
                        sh 'node scripts/setup-creds.js'
                    } else {
                        echo "CREATE_NEW_USERS is false. Using repo hardcoded user credentials."
                        // Create empty creds.env so readFile won't fail
                        sh 'touch creds.env'
                    }
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Run Replicator') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    echo "Starting Replicator..."
                    // Clean up old allure results to prevent merging with previous runs
                    sh 'rm -rf allure-results allure-report reporter.log'
                    def config = """[{
  "sourceSymbol": "${env.SRC}",
  "targetSymbol": "${env.TGT}",
  "minSize": ${params.MIN_SIZE},
  "maxSize": ${params.MAX_SIZE},
  "depthLevels": 10,
  "qtyChangeTolerance": 0.25,
  "enableTradeSync": ${params.ENABLE_TRADE_SYNC},
  "bufferPct": ${params.BUFFER_PCT},
  "cancelOnStop": true,
  "tradeDelayMs": 0
}]"""
                    // Load the dynamically generated credentials
                    def credsFile = readFile('creds.env').trim()
                    def dynamicCreds = credsFile ? credsFile.split('\n').toList() : []
                    def envVars = ["MARKET_CONFIGS=${config}", "REPORTER_PORT=3001"] + dynamicCreds

                    withEnv(envVars) {
                        // Start the reporter in the background
                        sh 'node reporter.js > reporter.log 2>&1 &'
                        // Give it a moment to bind to the port
                        sleep(time: 3, unit: 'SECONDS')

                        // The replicator now includes the QA reporter and web UI.
                        // It runs in the foreground until aborted.
                        echo "Starting replicator for ${env.SRC} — runs until aborted."
                        sh 'node replicator.js'
                    }
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // POST — always runs, even on abort
    // ─────────────────────────────────────────────────────────────────────
    post {
        always {
            script {
                echo "=== POST: Stopping all processes ==="
                // Gracefully stop the reporter first to allow it to flush results
                sh "pkill -f 'node reporter.js' || true"
                sh "pkill -f 'node replicator.js' || true"
                sleep(time: 3, unit: 'SECONDS') // Wait for files to be written

                echo "=== POST: Preparing Allure results ==="
                // Ensure the final metadata files are written
                sh 'node reporter.js --flush || true'

                // Print reporter log for debugging, especially if results are missing
                echo "=== Replicator log tail ==="
                sh 'tail -50 reporter.log || true'

                // Let the Allure Plugin handle the report generation and publishing
                echo "Archiving Allure results..."
                allure includeProperties: false, results: [[path: 'allure-results']]
            }

            // Archive the raw allure-results JSON for re-processing if needed
            archiveArtifacts(
                artifacts:     'allure-results/*.json, reporter.log',
                allowEmptyArchive: true
            )
        }

        aborted {
            echo "Build aborted. Open orders being cancelled by replicator (cancelOnStop: true)."
        }
        failure {
            echo "Build failed. Check Validate stage or reporter.log for details."
        }
        success {
            echo "Replicator exited cleanly."
        }
    }
}