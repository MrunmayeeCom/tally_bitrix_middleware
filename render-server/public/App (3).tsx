import {PricingAndCheckout} from "../public/PricingandCheckout";

export default function App() {
  return (
    <PricingAndCheckout onBack={() => window.history.back()} />
  );
}