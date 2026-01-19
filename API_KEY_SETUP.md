# HOW TO SET UP YOUR API KEY

Since this is a GitHub Pages deployment (static site), you cannot use environment variables the traditional way. Instead, you'll need to configure your API key directly in the browser using the Integration Center.

## Steps to Configure:

1. **Open the deployed app**: https://mikiemapo.github.io/mikiemapo-the-official-ANALOGICAL-INSIGHT-EXTRACTOR--and-Correct-Answer-scribler/

2. **Get your Gemini API Key**:
   - Visit: https://aistudio.google.com/app/apikey
   - Create a new API key or use an existing one
   - Copy the key

3. **Configure in the app**:
   - Click the gear icon (⚙️) in the top right (Integration Center)
   - The app will detect that no API key is set
   - **Important**: For GitHub Pages deployment, you need to manually paste your API key into the browser's local storage or use the Settings drawer
   
## Alternative: Local Development with Environment Variables

If you want to run locally with environment variables:

1. Create a `.env.local` file in the project root
2. Add: `VITE_API_KEY=your_api_key_here`
3. Run: `npm run dev`

**Note**: The `.env.local` file will NOT work for GitHub Pages deployment - it only works locally!

## For GitHub Pages (Static Deployment):

Currently, the app expects the API key to be configured in the browser. We need to update the app to allow runtime configuration through localStorage.

Would you like me to add a feature to configure the API key through the Settings panel?
