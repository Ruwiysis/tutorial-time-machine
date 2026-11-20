# Fixtures

Tutorial-style pages with deliberately outdated code, used for demos and tests.
Each page also contains lines that are still correct, to show there are no false alarms.

| Page | Outdated (should be flagged) | Still current (should stay quiet) |
|---|---|---|
| `firebase-v8-firestore.html` (hero demo) | `import firebase from 'firebase/app'`, `firebase.initializeApp`, `firebase.firestore()`, `db.collection(...).add`, `FieldValue.serverTimestamp()`, `auth.signInAnonymously()`, `onAuthStateChanged` method style | Security rules block, `npm install` (version pin aside), plain DOM code |
| `react-17-render.html` | `ReactDOM.render`, `ReactDOM.hydrate`, `import ReactDOM from 'react-dom'` | The `Counter` component with `useState` |
| `openai-legacy-completion.html` | `openai.api_key = ...`, `openai.Completion.create`, `engine="text-davinci-003"`, `openai.error.RateLimitError` | File reading, `os.getenv`, `time.sleep` |
| `tensorflow-1-session.html` | `tf.placeholder`, `tf.Session()`, `tf.train.GradientDescentOptimizer`, `tf.global_variables_initializer()`, `feed_dict` | NumPy data generation, `tf.Variable`, `tf.reduce_mean`, `tf.square` |

Open a page directly in Chrome with the extension installed, or pick it in the web app.
