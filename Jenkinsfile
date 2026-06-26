pipeline {
    agent any

    parameters {
        string(
            name: 'BRANCH_NAME',
            defaultValue: 'fix/jenkins-ui-flag-and-bugs',
            description: 'Git branch to check out and run (e.g. main, feature/scenario-engine, fix/jenkins-ui-flag-and-bugs)'
        )
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
            choices: ['true', 'false'],
            description: 'Mirror Binance taker trades on testnet via IOC orders (default: true)'
        )
        booleanParam(
            name: 'ENABLE_LOCAL_UI',
            defaultValue: true,
            description: 'Start the local web UI on this executor\'s dedicated port. Disable for fully headless runs. When enabled, an SSH tunnel command is printed in the console to access the UI over VPN.'
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
                    // Kill any node processes running for THIS specific symbol
                    sh "pkill -f 'node replicator.js --symbol=${env.SRC}' || true"
                    sh "pkill -f 'node reporter.js --symbol=${env.SRC}' || true"
                    // Forcefully free this executor's dedicated ports just in case
                    def executorNum = env.EXECUTOR_NUMBER ?: '0'
                    def repPort = 30000 + executorNum.toInteger()
                    def uiPort = 40000 + executorNum.toInteger()
                    sh "fuser -k ${repPort}/tcp || true"
                    sh "fuser -k ${uiPort}/tcp || true"
                    sleep(time: 3, unit: 'SECONDS')
                    echo "Previous instances stopped."
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Checkout') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    echo "Checking out branch: ${params.BRANCH_NAME}"
                    git url: 'https://github.com/MAniTejReddy1/testnet_replicator.git',
                        branch: params.BRANCH_NAME
                }
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
                        echo "New users created! Sleeping for 120 seconds to allow testnet funds and API keys to fully propagate..."
                        sleep(time: 120, unit: 'SECONDS')
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
                    def sources = env.SRC.split(',')
                    def targets = env.TGT.split(',')
                    def configObjs = []
                    for (int i = 0; i < sources.size(); i++) {
                        def src = sources[i].trim()
                        def tgt = targets.size() > i ? targets[i].trim() : src
                        configObjs.add("""{
  "sourceSymbol": "${src}",
  "targetSymbol": "${tgt}",
  "minSize": ${params.MIN_SIZE},
  "maxSize": ${params.MAX_SIZE},
  "depthLevels": 10,
  "qtyChangeTolerance": 0.25,
  "enableTradeSync": ${params.ENABLE_TRADE_SYNC},
  "bufferPct": ${params.BUFFER_PCT},
  "cancelOnStop": true,
  "tradeDelayMs": 0
}""")
                    }
                    def config = "[" + configObjs.join(",") + "]"
                    // Load the dynamically generated credentials
                    def credsFile = readFile('creds.env').trim()
                    def dynamicCreds = credsFile ? credsFile.split('\n').toList() : []
                    
                    // Assign dedicated ports based on the Jenkins executor to prevent collisions during concurrent builds
                    def executorNum = env.EXECUTOR_NUMBER ?: '0'
                    def repPort = 30000 + executorNum.toInteger()
                    def uiPort = 40000 + executorNum.toInteger()
                    def envVars = ["MARKET_CONFIGS=${config}", "REPORTER_PORT=${repPort}", "UI_PORT=${uiPort}", "ENABLE_LOCAL_UI=${params.ENABLE_LOCAL_UI}"] + dynamicCreds

                    // Print UI access info — direct URL via nginx reverse proxy
                    if (params.ENABLE_LOCAL_UI) {
                        def uiUrl = "https://qa-jenkins.dcxtools.com/replicator-${executorNum}/"
                        echo "=================================================================="
                        echo "Replicator UI is LIVE:"
                        echo "  ${uiUrl}"
                        echo "Open the URL above in your browser (VPN required)"
                        echo "=================================================================="
                        currentBuild.description = "<a href='${uiUrl}'>${uiUrl}</a> | ${env.SRC} → ${env.TGT}"
                    } else {
                        echo "UI is DISABLED for this run (ENABLE_LOCAL_UI=false). Running headless."
                        currentBuild.description = "HEADLESS | ${env.SRC} → ${env.TGT}"
                    }

                    withEnv(envVars) {
                        sh """
# 1. Start reporter in background, capture PID
node reporter.js > reporter.log 2>&1 &
REPORTER_PID=\$!
echo "Reporter started (PID \$REPORTER_PID)"

# 2. Start replicator in background, capture PID
node replicator.js &
REPLICATOR_PID=\$!
echo "Replicator started (PID \$REPLICATOR_PID) — branch: ${params.BRANCH_NAME}"

# 3. Write PIDs to files so the post-always block can kill them precisely
echo \$REPORTER_PID   > reporter.pid
echo \$REPLICATOR_PID > replicator.pid

# 4. Trap SIGTERM (Jenkins abort) to relay it gracefully before wait exits
trap 'echo "SIGTERM received — killing replicator (\$REPLICATOR_PID) and reporter (\$REPORTER_PID)"; kill -SIGTERM \$REPLICATOR_PID \$REPORTER_PID 2>/dev/null; sleep 4' TERM

# 5. Keep pipeline alive until Jenkins aborts or replicator exits
wait \$REPLICATOR_PID
"""
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

                // Prefer PID-file kill (precise) — fall back to pkill by name
                sh '''
                    if [ -f replicator.pid ]; then
                        RPID=$(cat replicator.pid)
                        echo "Sending SIGTERM to replicator PID $RPID"
                        kill -SIGTERM $RPID 2>/dev/null || true
                    else
                        pkill -f "node replicator.js" || true
                    fi

                    if [ -f reporter.pid ]; then
                        RPID=$(cat reporter.pid)
                        echo "Sending SIGTERM to reporter PID $RPID"
                        kill -SIGTERM $RPID 2>/dev/null || true
                    else
                        pkill -f "node reporter.js" || true
                    fi

                    # Belt-and-braces: free the dedicated UI/reporter ports
                    fuser -k ${REPORTER_PORT:-3001}/tcp 2>/dev/null || true
                    fuser -k ${UI_PORT:-3000}/tcp       2>/dev/null || true

                    sleep 4
                    rm -f replicator.pid reporter.pid
                '''

                echo "=== POST: Flushing Allure report ==="
                // Only flush if the reporter log exists (proves reporter ran)
                sh 'test -f reporter.log && node reporter.js --flush || true'

                echo "=== Replicator log (last 60 lines) ==="
                sh 'tail -60 reporter.log || true'

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