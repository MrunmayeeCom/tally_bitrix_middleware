import {PricingAndCheckout} from "./PricingandCheckout";

export default function App() {
  return (
    <PricingAndCheckout onBack={() => window.history.back()} />
  );
}