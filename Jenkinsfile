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
                // Install replicator deps + reporter deps (uuid for allure result IDs)
                sh 'npm install'
                sh 'npm install uuid --save'
                // Install Allure CLI for report generation
                sh 'npm install -g allure-commandline --save-dev 2>/dev/null || true'
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Run Replicator') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
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
                    withEnv(["MARKET_CONFIGS=${config}", "REPORTER_PORT=3001"]) {
                        // Start the reporter in the background
                        sh 'node reporter.js > reporter.log 2>&1 &'
                        // Give it a moment to bind to the port
                        sleep(time: 3, unit: 'SECONDS')

                        // The replicator now includes the QA reporter and web UI.
                        // It runs in the foreground until aborted.
                        // Logs are sent to reporter.log for post-build processing.
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
                sh "pkill -f 'node replicator.js' || true"
                sh "pkill -f 'node reporter.js' || true"

                // Give reporter 3s to finish writing any in-flight result files
                sleep(time: 3, unit: 'SECONDS')

                echo "=== POST: Generating Allure report ==="
                // Flush mode — writes environment.properties if not already written
                sh 'node reporter.js --flush || true'

                echo "=== Verifying Allure prerequisites ==="
                sh 'java -version || echo "Java not found, Allure report generation will fail."'
                sh 'ls -la allure-results/ || echo "allure-results directory not found."'

                // Only generate report if there are result files
                def resultFiles = sh(script: 'find allure-results -name "*.json" | wc -l', returnStdout: true).trim()
                if (resultFiles.toInteger() > 0) {
                    echo "Found ${resultFiles} result files. Generating Allure report..."
                    sh 'npx allure generate allure-results --clean -o allure-report' // Fail build if this fails
                    echo "=== Verifying Allure report generation ==="
                    sh 'ls -la allure-report/'
                } else {
                    echo "WARNING: No Allure result files found in allure-results/. Skipping report generation."
                }

                // Print reporter log for debugging
                echo "=== Replicator log tail ==="
                sh 'tail -50 reporter.log || true'
            }

            // Publish the HTML report in Jenkins UI
            // Requires: HTML Publisher plugin (standard Jenkins plugin)
            publishHTML(target: [
                allowMissing:           true,
                alwaysLinkToLastBuild:  true,
                keepAll:                true,
                reportDir:              'allure-report',
                reportFiles:            'index.html',
                reportName:             'QA Order Lifecycle Report',
                reportTitles:           "Order Lifecycle — ${env.SRC}",
            ])

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